/**
 * The public edge: one HTTP request in, one answer out, and the real work
 * happening after the answer has already gone.
 *
 * Three things have to be true before anything downstream runs, and each of them
 * is here because it cannot be anywhere else.
 *
 * **Answer first, work after.** Slack expects a response within about three
 * seconds and redelivers the event if it does not get one. A model call with
 * retries can take longer than that on its own, so waiting for the translation
 * before answering would guarantee a duplicate exactly when the system is
 * already slow. The response is decided before `handleMessage` is awaited, and
 * the work is handed back as `done` for the caller to keep alive.
 *
 * "Before `handleMessage`" rather than "immediately": the answer does wait on
 * `seen.firstTime`, which is a set lookup today and a network call the day there
 * are two processes. That call is on the critical path to the acknowledgement,
 * and a store that hangs hangs the ack with it.
 *
 * **Prove it came from Slack.** `src/slack/verify.ts` does the checking; this is
 * the only place it is called, and nothing reaches `handleMessage` that has not
 * been through it.
 *
 * **Recognise a redelivery.** `handleMessage` deliberately does not, and cannot:
 * the retry count and the event id live in the envelope, which `receive` never
 * sees. This is the only layer that holds both.
 *
 * Transport-agnostic on purpose. There is no `node:http` here, no framework and
 * no server — a request is a body and some headers, an answer is a status and a
 * string. That is what makes the whole edge testable without opening a port.
 */

import type { Seen } from '../core/seen.ts'
import { readEnvelope, verifySignature, type Envelope, type Headers } from '../slack/verify.ts'
import { handleMessage, type MessageOutcome, type Ports } from './handle.ts'

/**
 * What it takes to act on an envelope whose origin is already settled.
 *
 * Split out from `Edge` because Slack has two ways of delivering the same
 * envelope and only one of them is signed. Over a websocket the connection
 * itself is the proof, so there is nothing to verify — but the deduplication and
 * the ack-first ordering are identical, and having them written twice is how the
 * two paths would drift.
 */
export interface Work {
  readonly ports: Ports
  readonly seen: Seen
  /**
   * Where an outcome goes once the work is done.
   *
   * **Required**, and it was optional for one commit before that turned out to
   * contradict a rule this repository states plainly: never swallow an error. A
   * default no-op discards every `failed` outcome there is, and the caller who
   * most needs to be told is the one who never thought about it.
   *
   * A callback rather than a logger, so whatever ends up counting these — a log
   * line, a metric, a page — is chosen outside this module, and so a test can
   * assert on what happened after the response was already sent.
   */
  readonly report: (outcome: MessageOutcome) => void
}

export interface Edge extends Work {
  readonly signingSecret: string
  /** Injected so a test needs no control over the clock. */
  readonly now?: () => number
}

export interface HttpRequest {
  /** The body exactly as received. Parsing it before signing checks it breaks them. */
  readonly body: string
  readonly headers: Headers
}

export interface HttpResponse {
  readonly status: number
  readonly body: string
  /**
   * Everything that happens after Slack has been answered.
   *
   * Always present and never rejecting, so a caller can `await` it, ignore it,
   * or hand it to a platform's "keep this alive" primitive without checking
   * which case it is in.
   */
  readonly done: Promise<void>
}

const NOTHING = Promise.resolve()

const answer = (status: number, body: string, done: Promise<void> = NOTHING): HttpResponse => ({
  status,
  body,
  done,
})

/**
 * An envelope that is already known to have come from Slack.
 *
 * Everything here is common to both delivery paths: recognise a redelivery,
 * answer, and only then start the work.
 */
export async function acceptEnvelope(work: Work, envelope: Envelope): Promise<HttpResponse> {
  // Sent once, when the endpoint URL is first saved in app settings, and it is
  // answered with the challenge itself as plain text. Getting this wrong means
  // the app can never be installed at all.
  if (envelope.kind === 'challenge') return answer(200, envelope.challenge)

  // Something Slack sends that this app does not handle — `app_rate_limited`
  // today, whatever it adds next. Answered 200 on purpose: there is nothing to
  // retry, and a run of non-2xx responses is what makes Slack disable an app's
  // event subscriptions altogether.
  if (envelope.kind === 'ignored') return answer(200, `ignored:${envelope.type}`)

  // A delivery missing a piece of itself, which is a different thing. Not a 200:
  // that would tell Slack this was handled, which is untrue, and would absorb a
  // real fault into silence.
  if (envelope.kind === 'unusable') return answer(400, envelope.because)

  // Answered 200 either way: a redelivery Slack sent because it never heard back
  // is not an error, and reporting one would only produce another retry.
  if (!(await work.seen.firstTime(envelope.eventId))) return answer(200, 'duplicate')

  // The one line this whole file exists to arrange: started, deliberately not
  // awaited, and returned alongside a response that has already been decided.
  const done = handleMessage(work.ports, envelope.event)
    .then((outcome) => {
      work.report(outcome)
    })
    .catch(() => {
      // `handleMessage` documents that it never rejects and its tests hold it to
      // that, so this exists for `report` itself: a caller's logger throwing must
      // not become an unhandled rejection surfacing long after the request that
      // produced it was answered — with nothing left to attach it to.
    })

  return answer(200, 'ok', done)
}

export async function handleRequest(edge: Edge, request: HttpRequest): Promise<HttpResponse> {
  const now = edge.now?.() ?? Date.now()

  const signature = verifySignature(edge.signingSecret, request.body, request.headers, now)
  if (!signature.ok) return answer(401, signature.because)

  return acceptEnvelope(edge, readEnvelope(request.body, request.headers))
}
