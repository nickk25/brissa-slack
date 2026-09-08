import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { EphemeralRequest } from './send.ts'
import { createSlackApi } from './web.ts'

const request: EphemeralRequest = {
  channel: 'C1',
  user: 'U-nick',
  blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Me viene bien.' } }],
  text: 'Me viene bien.',
}

const responding = (body: unknown, status = 200): typeof fetch =>
  (async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })) as unknown as typeof fetch

test('INV-slack-33 the call carries the token and the request, as Slack expects them', async () => {
  let seen: { url?: string; init?: RequestInit } = {}
  const fake = (async (url: string, init: RequestInit) => {
    seen = { url, init }
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }) as unknown as typeof fetch

  const result = await createSlackApi('xoxb-secret', fake).postEphemeral(request)

  assert.deepEqual(result, { ok: true })
  assert.equal(seen.url, 'https://slack.com/api/chat.postEphemeral')
  assert.equal(seen.init?.method, 'POST')
  assert.deepEqual(seen.init?.headers, {
    authorization: 'Bearer xoxb-secret',
    'content-type': 'application/json; charset=utf-8',
  })
  assert.deepEqual(JSON.parse(String(seen.init?.body)), request)
})

test('INV-slack-34 Slack refusing with a 200 is still a refusal', async () => {
  // Slack answers 200 with `ok: false` for application errors. Reading only the
  // status code would count every one of those as a delivered translation.
  const api = createSlackApi('t', responding({ ok: false, error: 'user_not_in_channel' }))
  assert.deepEqual(await api.postEphemeral(request), { ok: false, error: 'user_not_in_channel' })
})

test('INV-slack-35 a failure that never reached the application still has a name', async () => {
  // A revoked token or a rate limit answers with a status, not a body. It has to
  // arrive in the same shape as everything else or the caller has no vocabulary
  // for it.
  const api = createSlackApi('t', responding({}, 429))
  assert.deepEqual(await api.postEphemeral(request), { ok: false, error: 'http_429' })
})

test('INV-slack-36 a dropped connection is reported, never thrown', async () => {
  // The caller's entire design is that a translation which failed to appear must
  // be visible as such. An exception here would arrive somewhere with no
  // vocabulary for it, and `handleMessage` would record it as a `send` failure
  // with a stack trace instead of a reason.
  const exploding = (async () => {
    throw new Error('ECONNRESET')
  }) as unknown as typeof fetch

  const result = await createSlackApi('t', exploding).postEphemeral(request)
  assert.equal(result.ok, false)
  assert.ok(result.error?.includes('ECONNRESET'))
})
