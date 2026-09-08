import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RESPONSE_URL_BUDGET, readShortcut, replyPrivately } from './shortcut.ts'

const payload = (over: Record<string, unknown> = {}) => ({
  type: 'message_action',
  callback_id: 'translate_message',
  response_url: 'https://hooks.slack.test/actions/T1/1/abc',
  channel: { id: 'C-berlin' },
  user: { id: 'U-nick' },
  message: { user: 'U-jens', ts: '1.1', text: 'Passt bei mir auch!' },
  ...over,
})

test('INV-slack-46 a shortcut says who asked, whose message it was, and where to answer', async () => {
  const read = readShortcut(payload())
  assert.ok(read.ok)
  assert.deepEqual(read.shortcut, {
    callbackId: 'translate_message',
    channelId: 'C-berlin',
    invokedBy: 'U-nick',
    authorId: 'U-jens',
    text: 'Passt bei mir auch!',
    responseUrl: 'https://hooks.slack.test/actions/T1/1/abc',
  })
})

test('INV-slack-47 asking about your own message is allowed here', async () => {
  // On the automatic path this is `own-message` and it is skipped. Here somebody
  // clicked, and refusing a request because nobody requested it makes no sense.
  const read = readShortcut(payload({ user: { id: 'U-jens' } }))
  assert.ok(read.ok && read.shortcut.invokedBy === 'U-jens' && read.shortcut.authorId === 'U-jens')
})

test('INV-slack-48 a bot’s message still has an author when somebody asks to read it', async () => {
  // A bot message carries `bot_id` and often no `user`. Unlike the automatic
  // path this is no reason to refuse — but the answer must still name a writer.
  const read = readShortcut(payload({ message: { bot_id: 'B9', text: 'Bereitstellung fehlgeschlagen.' } }))
  assert.ok(read.ok && read.shortcut.authorId === 'B9')
})

test('INV-slack-49 a shortcut with nowhere to answer is refused', async () => {
  // Answering is the entire interaction. Without a response_url the click has
  // produced nothing, and pretending otherwise hides it.
  const noUrl = readShortcut(payload({ response_url: undefined }))
  assert.deepEqual(noUrl, { ok: false, because: 'no-response-url' })
})

test('INV-slack-50 anything that is not a message shortcut is refused by name', async () => {
  for (const [input, because] of [
    [payload({ type: 'block_actions' }), 'not-a-shortcut'],
    ['a string', 'not-a-shortcut'],
    [null, 'not-a-shortcut'],
    [payload({ channel: {} }), 'no-channel'],
    [payload({ message: undefined }), 'no-message'],
    [payload({ message: { user: 'U-jens', text: '   ' } }), 'no-text'],
  ] as const) {
    assert.deepEqual(readShortcut(input), { ok: false, because }, String(because))
  }
})

test('INV-slack-51 a thread reply keeps its thread; a top-level message carries none', async () => {
  const threaded = readShortcut(payload({ message: { user: 'U-jens', text: 'ja', thread_ts: '1699.9' } }))
  assert.ok(threaded.ok && threaded.shortcut.threadId === '1699.9')

  const top = readShortcut(payload())
  assert.ok(top.ok && !('threadId' in top.shortcut))
})

test('INV-slack-52 the private answer never names its own response type', async () => {
  // `ephemeral` is the documented default. Naming it invites somebody to change
  // it to `in_channel` one day and publish a colleague's translation to the room.
  let sent: { url?: string; body?: unknown } = {}
  const fake = (async (url: string, init: RequestInit) => {
    sent = { url, body: JSON.parse(String(init.body)) }
    return { ok: true, status: 200 }
  }) as unknown as typeof fetch

  const result = await replyPrivately('https://hooks.slack.test/x', { blocks: [], text: 'hi' }, fake)

  assert.deepEqual(result, { ok: true })
  assert.equal(sent.url, 'https://hooks.slack.test/x')
  assert.deepEqual(sent.body, { blocks: [], text: 'hi' })
  assert.ok(!JSON.stringify(sent.body).includes('in_channel'))
})

test('INV-slack-53 an answer that never arrived is reported, not thrown', async () => {
  const exploding = (async () => {
    throw new Error('ENOTFOUND')
  }) as unknown as typeof fetch
  const result = await replyPrivately('https://hooks.slack.test/x', { blocks: [], text: 'hi' }, exploding)
  assert.equal(result.ok, false)
  assert.ok(!result.ok && result.detail.includes('ENOTFOUND'))

  const refused = (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch
  assert.deepEqual(await replyPrivately('https://hooks.slack.test/x', { blocks: [], text: 'hi' }, refused), {
    ok: false,
    detail: 'http_404',
  })
})

test('INV-slack-54 the response budget is the one Slack documents', async () => {
  // Five answers within thirty minutes. Written down because the number decides
  // whether a retry is possible at all, and nothing else in the code says it.
  assert.deepEqual(RESPONSE_URL_BUDGET, { responses: 5, windowMinutes: 30 })
})
