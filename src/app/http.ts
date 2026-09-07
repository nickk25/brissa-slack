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
 * already slow. The response is therefore decided synchronously and the work is
 * handed back as `done` for the caller to keep alive.
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
import { readEnvelope, verifySignature, type Headers } from '../slack/verify.ts'
import { handleMessage, type MessageOutcome, type Ports } from './handle.ts'

export interface Edge {
  readonly ports: Ports
  readonly signingSecret: string
  readonly seen: Seen
  /** Injected so a test needs no control over the clock. */
  readonly now?: () => number
  /**
   * Where an outcome goes once the work is done.
   *
   * Optional, and that is a decision worth being uneasy about: nothing counts
   * these yet. It is a callback rather than a logger so that whatever ends up
   * counting them — a log line, a metric, a page — is chosen outside this
   * module, and so that a test can assert on what happened after the response
   * was already sent.
   */
  readonly report?: (outcome: MessageOutcome) => void
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

export async function handleRequest(edge: Edge, request: HttpRequest): Promise<HttpResponse> {
  const now = edge.now?.() ?? Date.now()

  // Defaulted once rather than called optionally below. An optional call inside
  // the `.then` would be swallowed by the `.catch` if it were ever wrong, which
  // is the one place a mistake could hide indefinitely.
  const report = edge.report ?? (() => {})

  const signature = verifySignature(edge.signingSecret, request.body, request.headers, now)
  if (!signature.ok) return answer(401, signature.because)

  const envelope = readEnvelope(request.body, request.headers)

  // Sent once, when the endpoint URL is first saved in app settings, and it is
  // answered with the challenge itself as plain text. Getting this wrong means
  // the app can never be installed at all.
  if (envelope.kind === 'challenge') return answer(200, envelope.challenge)

  // Not a 200. A 200 would tell Slack this was handled, which is untrue, and a
  // request we cannot parse is a real problem that should stay visible rather
  // than be absorbed into silence.
  if (envelope.kind === 'unusable') return answer(400, envelope.because)

  // Answered 200 either way: a redelivery Slack sent because it never heard back
  // is not an error, and reporting one would only produce another retry.
  if (!(await edge.seen.firstTime(envelope.eventId))) return answer(200, 'duplicate')

  // The one line this whole file exists to arrange: started, deliberately not
  // awaited, and returned alongside a response that has already been decided.
  const done = handleMessage(edge.ports, envelope.event)
    .then((outcome) => {
      report(outcome)
    })
    .catch(() => {
      // `handleMessage` documents that it never rejects and its tests hold it to
      // that. This is here for `report` itself: a caller's logger throwing must
      // not become an unhandled rejection that takes the process down long after
      // the request it came from was answered.
    })

  return answer(200, 'ok', done)
}
