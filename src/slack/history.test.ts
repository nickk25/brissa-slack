import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createSlackHistory, whoOwns } from './history.ts'

const respond = (body: unknown, status = 200): typeof fetch =>
  (async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })) as unknown as typeof fetch

test('INV-slack-56 an ordinary read returns messages newest first, each with an author and text, skipping what is not one', async () => {
  // A join, a topic change and a blank entry mirror receive.ts's own exclusion
  // list: an event about the channel is not a message in it, and an empty
  // entry has nothing a translation could act on.
  const body = {
    ok: true,
    messages: [
      { user: 'U-jens', text: 'Passt bei mir auch!' },
      { subtype: 'channel_join', user: 'U-nick', text: '<@U-nick> has joined the channel' },
      { user: 'U-jens', text: '   ' },
      { subtype: 'channel_topic', user: 'U-jens', text: 'set the channel topic' },
      { user: 'U-nick', text: 'Suena bien.' },
    ],
  }
  const history = createSlackHistory('xoxp-secret', respond(body))
  const result = await history.read('C-berlin', 10)

  assert.deepEqual(result, {
    ok: true,
    messages: [
      { authorId: 'U-jens', text: 'Passt bei mir auch!' },
      { authorId: 'U-nick', text: 'Suena bien.' },
    ],
  })
})

test('INV-slack-57 a message with no user still has an author', async () => {
  // A bot message carries `bot_id` and often no `user` at all — the same
  // fallback the shortcut and the events adapter both use.
  const body = { ok: true, messages: [{ bot_id: 'B9', text: 'Bereitstellung fehlgeschlagen.' }] }
  const history = createSlackHistory('xoxp-secret', respond(body))
  const result = await history.read('C-berlin', 1)

  assert.deepEqual(result, { ok: true, messages: [{ authorId: 'B9', text: 'Bereitstellung fehlgeschlagen.' }] })
})

test('INV-slack-58 Slack refusing with a 200 is reported as data', async () => {
  // Slack answers 200 with `ok: false` for application errors — reading only
  // the status code would count every one of those as a successful read.
  const history = createSlackHistory('xoxp-secret', respond({ ok: false, error: 'not_in_channel' }))
  assert.deepEqual(await history.read('C-berlin', 5), { ok: false, detail: 'not_in_channel' })
})

test('INV-slack-59 a bad status and a dropped connection are both reported, never thrown', async () => {
  const refused = createSlackHistory('xoxp-secret', respond({}, 429))
  assert.deepEqual(await refused.read('C-berlin', 5), { ok: false, detail: 'http_429' })

  const exploding = (async () => {
    throw new Error('ECONNRESET')
  }) as unknown as typeof fetch
  const dropped = createSlackHistory('xoxp-secret', exploding)
  const result = await dropped.read('C-berlin', 5)
  assert.equal(result.ok, false)
  assert.ok(!result.ok && result.detail.includes('ECONNRESET'))
})

test('INV-slack-60 the call reads with the user token and never posts anything', async () => {
  let seen: { url?: string; init?: RequestInit } = {}
  const fake = (async (url: string, init: RequestInit) => {
    seen = { url, init }
    return { ok: true, status: 200, json: async () => ({ ok: true, messages: [] }) }
  }) as unknown as typeof fetch

  await createSlackHistory('xoxp-user-secret', fake).read('C-berlin', 5)

  assert.ok(seen.url?.startsWith('https://slack.com/api/conversations.history?'))
  assert.ok(seen.url?.includes('channel=C-berlin'))
  // What the limit means is INV-slack-69's business; here it only has to be sent.
  assert.ok(seen.url?.includes('limit='))
  assert.equal(seen.init?.method, 'GET')
  assert.deepEqual(seen.init?.headers, { authorization: 'Bearer xoxp-user-secret' })
  // A GET carries no body — structurally, this call cannot post anything.
  assert.equal(seen.init?.body, undefined)
})

test('INV-slack-61 only history scopes are requested', () => {
  // `channels:history`, `groups:history`, `im:history`, `mpim:history` and
  // nothing else — no search, no files, no profile reads. A scope this file
  // does not need is a permission that cannot leak.
  const manifest = JSON.parse(readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8')) as {
    oauth_config: { scopes: { user?: readonly string[] } }
  }
  assert.deepEqual(
    [...manifest.oauth_config.scopes.user ?? []].sort(),
    ['channels:history', 'groups:history', 'im:history', 'mpim:history'].sort(),
  )
})

test('INV-slack-68 whose account a token belongs to is asked, not assumed', async () => {
  // Printed at startup and used to refuse everybody else, so a wrong answer
  // here would either lock out the owner or quietly serve a colleague.
  const ok = (async () => ({ ok: true, status: 200, json: async () => ({ ok: true, user_id: 'U-nick' }) })) as unknown as typeof fetch
  assert.equal(await whoOwns('xoxp-x', ok), 'U-nick')

  // A credential nobody could check the owner of comes back undefined rather
  // than as an optimistic guess — and undefined is refused upstream.
  const refused = (async () => ({ ok: true, status: 200, json: async () => ({ ok: false, error: 'invalid_auth' }) })) as unknown as typeof fetch
  assert.equal(await whoOwns('xoxp-stale', refused), undefined)

  const broken = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch
  assert.equal(await whoOwns('xoxp-x', broken), undefined)

  const exploding = (async () => { throw new Error('ENOTFOUND') }) as unknown as typeof fetch
  assert.equal(await whoOwns('xoxp-x', exploding), undefined)
})

test('INV-slack-69 a count means messages a person wrote, not entries Slack returned', async () => {
  // Slack's own `limit` counts raw entries, and joins, topic changes and blanks
  // are dropped afterwards. Asking for exactly five and then filtering means
  // `/translate 5` quietly translates two, with nothing saying so.
  let askedFor = ''
  const noisy = (async (url: string) => {
    askedFor = new URL(url).searchParams.get('limit') ?? ''
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        messages: [
          { user: 'U1', text: 'eins' },
          { subtype: 'channel_join', user: 'U2', text: 'joined' },
          { user: 'U3', text: 'zwei' },
          { subtype: 'channel_topic', user: 'U4', text: 'topic' },
          { user: 'U5', text: 'drei' },
          { user: 'U6', text: '   ' },
          { user: 'U7', text: 'vier' },
        ],
      }),
    }
  }) as unknown as typeof fetch

  const read = await createSlackHistory('xoxp-x', noisy).read('C1', 3)

  // More was asked for than wanted, because some of it was never going to count.
  assert.ok(Number(askedFor) > 3)
  assert.ok(read.ok)
  assert.deepEqual(read.ok && read.messages.map((m) => m.text), ['eins', 'zwei', 'drei'])
})
