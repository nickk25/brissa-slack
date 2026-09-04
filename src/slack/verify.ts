/**
 * Proving a request came from Slack, and reading the envelope it arrived in.
 *
 * This is the only security boundary in the product. The endpoint is a public
 * URL that anyone can POST to, and everything downstream — the model call, the
 * ephemeral, the reader's channel — happens because something here said yes. A
 * missing check does not fail loudly; it works perfectly for Slack and works
 * just as well for everybody else.
 *
 * Slack signs `v0:{timestamp}:{body}` with the app's signing secret. Two things
 * follow that are easy to get wrong and impossible to notice:
 *
 * - The body must be the **raw bytes**, before any JSON parsing. A parse and
 *   re-serialise changes whitespace and key order, and the signature stops
 *   matching for reasons that look like a Slack outage.
 * - The comparison must be timing-safe. A byte-by-byte early exit leaks the
 *   expected signature to anyone patient enough to measure, one byte at a time.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { SlackMessageEvent } from './receive.ts'

/** Header names arrive in whatever case the proxy felt like. */
export type Headers = Readonly<Record<string, string | undefined>>

const header = (headers: Headers, name: string): string | undefined => {
  const wanted = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return headers[key]
  }
  return undefined
}

/**
 * How old a request may be.
 *
 * Slack's own recommendation, and the reason it exists is replay: a signature
 * stays valid forever, so a request captured once could be sent again at any
 * time. Five minutes is long enough to survive a slow network and short enough
 * that a captured request is worthless by the time anyone finds it.
 */
export const MAX_AGE_SECONDS = 300

export type Verification =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly because: 'no-signature' | 'no-timestamp' | 'bad-timestamp' | 'too-old' | 'bad-signature'
    }

/**
 * @param secret   the app's signing secret
 * @param raw      the request body exactly as received, before parsing
 * @param headers  the request headers
 * @param nowMs    the current time in milliseconds
 */
export function verifySignature(secret: string, raw: string, headers: Headers, nowMs: number): Verification {
  const signature = header(headers, 'x-slack-signature')
  if (!signature) return { ok: false, because: 'no-signature' }

  const timestamp = header(headers, 'x-slack-request-timestamp')
  if (!timestamp) return { ok: false, because: 'no-timestamp' }

  // `Number` on a non-numeric string is NaN, and every comparison against NaN is
  // false — including the age check below, which would therefore pass.
  const sent = Number(timestamp)
  if (!Number.isFinite(sent)) return { ok: false, because: 'bad-timestamp' }

  // Absolute difference, so a timestamp from the future is refused too. A clock
  // far ahead is not a request that is merely early; it is a request whose age
  // we cannot reason about at all.
  if (Math.abs(nowMs / 1000 - sent) > MAX_AGE_SECONDS) return { ok: false, because: 'too-old' }

  const expected = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${raw}`).digest('hex')}`

  // `timingSafeEqual` throws on a length mismatch rather than returning false,
  // which would turn a malformed signature into a crash — and a crash in the
  // one place an attacker controls the input is its own problem.
  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  if (a.length !== b.length) return { ok: false, because: 'bad-signature' }
  if (!timingSafeEqual(a, b)) return { ok: false, because: 'bad-signature' }

  return { ok: true }
}

/**
 * What Slack put in the outer envelope, as opposed to the message itself.
 *
 * `receive` deliberately never sees this: it is handed the inner event and knows
 * nothing about delivery. But the envelope is where the two facts the edge needs
 * live — the id that makes a retry recognisable, and the challenge Slack sends
 * once when the endpoint is first configured.
 */
export type Envelope =
  | { readonly kind: 'challenge'; readonly challenge: string }
  | {
      readonly kind: 'event'
      readonly eventId: string
      readonly event: SlackMessageEvent
      /** 0 on a first delivery, 1 and up on Slack's own retries. */
      readonly retryNum: number
    }
  | { readonly kind: 'unusable'; readonly because: 'not-json' | 'unknown-type' | 'no-event-id' | 'no-event' }

interface RawEnvelope {
  readonly type?: string
  readonly challenge?: string
  readonly event_id?: string
  readonly event?: SlackMessageEvent
}

export function readEnvelope(raw: string, headers: Headers = {}): Envelope {
  let body: RawEnvelope
  try {
    body = JSON.parse(raw) as RawEnvelope
  } catch {
    return { kind: 'unusable', because: 'not-json' }
  }

  // Sent once, when the endpoint URL is first saved in app settings. Answering
  // it is the whole handshake; failing to means the app can never be installed.
  if (body.type === 'url_verification') {
    return typeof body.challenge === 'string'
      ? { kind: 'challenge', challenge: body.challenge }
      : { kind: 'unusable', because: 'unknown-type' }
  }

  if (body.type !== 'event_callback') return { kind: 'unusable', because: 'unknown-type' }

  // Without an id a retry is indistinguishable from a new message, and the only
  // safe reading of "we cannot tell" is to refuse rather than to risk a second
  // copy of every translation.
  if (!body.event_id) return { kind: 'unusable', because: 'no-event-id' }
  if (!body.event) return { kind: 'unusable', because: 'no-event' }

  const retry = Number(header(headers, 'x-slack-retry-num') ?? 0)

  return {
    kind: 'event',
    eventId: body.event_id,
    event: body.event,
    retryNum: Number.isFinite(retry) ? retry : 0,
  }
}
