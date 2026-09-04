import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import { MAX_AGE_SECONDS, readEnvelope, verifySignature } from './verify.ts'

const SECRET = 'a-signing-secret'
const BODY = '{"type":"event_callback","event_id":"Ev1","event":{"type":"message"}}'
const NOW_MS = 1_700_000_000_000
const TS = String(NOW_MS / 1000)

const sign = (raw: string, timestamp: string, secret = SECRET): string =>
  `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${raw}`).digest('hex')}`

const headers = (over: Record<string, string | undefined> = {}) => ({
  'x-slack-signature': sign(BODY, TS),
  'x-slack-request-timestamp': TS,
  ...over,
})

test('INV-slack-19 a request Slack really signed is accepted', async () => {
  assert.deepEqual(verifySignature(SECRET, BODY, headers(), NOW_MS), { ok: true })
})

test('INV-slack-20 header casing is the proxy’s business, not ours', async () => {
  // Node lowercases them; a proxy in front may not. A signature check that only
  // works behind one deployment is a check that fails open behind another.
  const mixed = { 'X-Slack-Signature': sign(BODY, TS), 'X-Slack-Request-Timestamp': TS }
  assert.deepEqual(verifySignature(SECRET, BODY, mixed, NOW_MS), { ok: true })
})

test('INV-slack-21 a signature made with another secret is refused', async () => {
  const forged = headers({ 'x-slack-signature': sign(BODY, TS, 'not-the-secret') })
  assert.deepEqual(verifySignature(SECRET, BODY, forged, NOW_MS), { ok: false, because: 'bad-signature' })
})

test('INV-slack-22 a body altered after signing is refused', async () => {
  // The reason the raw bytes must be kept: parse and re-serialise changes
  // whitespace and key order, and this is what that would look like.
  const altered = '{"type":"event_callback", "event_id":"Ev1","event":{"type":"message"}}'
  assert.deepEqual(verifySignature(SECRET, altered, headers(), NOW_MS), { ok: false, because: 'bad-signature' })
})

test('INV-slack-23 a request with no signature or no timestamp is refused by name', async () => {
  const noSig = { 'x-slack-request-timestamp': TS }
  const noTs = { 'x-slack-signature': sign(BODY, TS) }
  assert.deepEqual(verifySignature(SECRET, BODY, noSig, NOW_MS), { ok: false, because: 'no-signature' })
  assert.deepEqual(verifySignature(SECRET, BODY, noTs, NOW_MS), { ok: false, because: 'no-timestamp' })
})

test('INV-slack-24 a replayed request stops being valid, in both directions', async () => {
  // A signature never expires on its own, so age is the only thing that makes a
  // captured request worthless. Refused from the future too: a clock far ahead
  // is not an early request, it is one whose age cannot be reasoned about.
  const old = String(NOW_MS / 1000 - MAX_AGE_SECONDS - 1)
  const ahead = String(NOW_MS / 1000 + MAX_AGE_SECONDS + 1)
  for (const t of [old, ahead]) {
    const h = { 'x-slack-signature': sign(BODY, t), 'x-slack-request-timestamp': t }
    assert.deepEqual(verifySignature(SECRET, BODY, h, NOW_MS), { ok: false, because: 'too-old' })
  }

  // And the boundary itself is inside, not outside.
  const edge = String(NOW_MS / 1000 - MAX_AGE_SECONDS)
  const h = { 'x-slack-signature': sign(BODY, edge), 'x-slack-request-timestamp': edge }
  assert.deepEqual(verifySignature(SECRET, BODY, h, NOW_MS), { ok: true })
})

test('INV-slack-25 a timestamp that is not a number is refused rather than compared', async () => {
  // `Number('soon')` is NaN and every comparison against NaN is false, so the
  // age check would pass. This is the mutation that turns a guard into a hole.
  const h = { 'x-slack-signature': sign(BODY, 'soon'), 'x-slack-request-timestamp': 'soon' }
  assert.deepEqual(verifySignature(SECRET, BODY, h, NOW_MS), { ok: false, because: 'bad-timestamp' })
})

test('INV-slack-26 a signature of the wrong length is refused, not thrown', async () => {
  // `timingSafeEqual` throws on a length mismatch, and a crash in the one place
  // an attacker controls the input is its own problem.
  const h = headers({ 'x-slack-signature': 'v0=short' })
  assert.deepEqual(verifySignature(SECRET, BODY, h, NOW_MS), { ok: false, because: 'bad-signature' })
})

test('INV-slack-27 the setup handshake is recognised and answered', async () => {
  // Sent once, when the endpoint URL is first saved. Failing it means the app
  // can never be installed at all.
  const raw = JSON.stringify({ type: 'url_verification', challenge: 'abc123' })
  assert.deepEqual(readEnvelope(raw), { kind: 'challenge', challenge: 'abc123' })
})

test('INV-slack-28 an event envelope yields the id a retry is recognised by', async () => {
  const raw = JSON.stringify({
    type: 'event_callback',
    event_id: 'Ev0001',
    event: { type: 'message', channel: 'C1', text: 'hallo' },
  })
  assert.deepEqual(readEnvelope(raw, { 'x-slack-retry-num': '2' }), {
    kind: 'event',
    eventId: 'Ev0001',
    event: { type: 'message', channel: 'C1', text: 'hallo' },
    retryNum: 2,
  })
})

test('INV-slack-29 a first delivery is retry zero, not an absent one', async () => {
  // The header is missing on a first delivery. Absent must read as zero rather
  // than as NaN, which would compare false against every threshold.
  const raw = JSON.stringify({ type: 'event_callback', event_id: 'Ev1', event: { type: 'message' } })
  const first = readEnvelope(raw)
  assert.ok(first.kind === 'event' && first.retryNum === 0)

  const junk = readEnvelope(raw, { 'x-slack-retry-num': 'again' })
  assert.ok(junk.kind === 'event' && junk.retryNum === 0)
})

test('INV-slack-30 an envelope we cannot use says which part was missing', async () => {
  // Including the one that matters most: without an id, a retry is
  // indistinguishable from a new message, and the only safe reading of "we
  // cannot tell" is to refuse rather than risk a second copy of a translation.
  assert.deepEqual(readEnvelope('not json at all'), { kind: 'unusable', because: 'not-json' })
  assert.deepEqual(readEnvelope('{"type":"something_else"}'), { kind: 'unusable', because: 'unknown-type' })
  assert.deepEqual(readEnvelope('{"type":"url_verification"}'), { kind: 'unusable', because: 'unknown-type' })
  assert.deepEqual(readEnvelope('{"type":"event_callback","event":{}}'), {
    kind: 'unusable',
    because: 'no-event-id',
  })
  assert.deepEqual(readEnvelope('{"type":"event_callback","event_id":"Ev1"}'), {
    kind: 'unusable',
    because: 'no-event',
  })
})
