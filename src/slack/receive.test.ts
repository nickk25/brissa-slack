import assert from 'node:assert/strict'
import { test } from 'node:test'
import { receive } from './receive.ts'
import type { SlackMessageEvent } from './receive.ts'

/**
 * A Slack event, with fields overridden or genuinely removed.
 *
 * `omit` exists because the config forbids passing `undefined` for an optional
 * field, and rightly: Slack omitting `user` and Slack sending `user: undefined`
 * are different events, and the tests below turn on that difference.
 */
const event = (over: Partial<SlackMessageEvent> = {}, omit: (keyof SlackMessageEvent)[] = []): SlackMessageEvent => {
  const base: SlackMessageEvent = {
    type: 'message',
    channel: 'C1',
    user: 'U-jens',
    text: 'Passt bei mir auch!',
    ts: '1788325357.261719',
    ...over,
  }
  const out: Record<string, unknown> = { ...base }
  for (const key of omit) delete out[key]
  return out as SlackMessageEvent
}

test('INV-slack-01 an ordinary message becomes four fields the core can reason about', () => {
  const r = receive(event())
  assert.equal(r.ok, true)
  assert.deepEqual(r.ok && r.message, {
    channelId: 'C1',
    authorId: 'U-jens',
    fromBot: false,
    text: 'Passt bei mir auch!',
  })
})

test('INV-slack-02 a bot message is marked as one, which is what breaks the loop', () => {
  // Brissa's own translations arrive back through this same path. Without the
  // flag it would translate itself, and then translate that.
  const r = receive(event({ bot_id: 'B-brissa' }, ['user']))
  assert.ok(r.ok && r.message.fromBot)
})

test('INV-slack-03 a bot message with no user still has an author', () => {
  // Slack omits `user` on some bot messages. An empty author would match nobody
  // and therefore be treated as somebody, defeating the core's own-message rule.
  const r = receive(event({ bot_id: 'B-brissa' }, ['user']))
  assert.ok(r.ok && r.message.authorId.length > 0)
})

test('INV-slack-04 an edit is not a new message', () => {
  // `message_changed` carries a nested payload with a different shape entirely,
  // and reading it as a message would translate an edit nobody made.
  const r = receive(event({ subtype: 'message_changed' }))
  assert.deepEqual(r, { ok: false, because: 'edited-or-special' })
})

test('INV-slack-05 a join or a topic change is not a message in the channel', () => {
  for (const subtype of ['channel_join', 'channel_leave', 'channel_topic']) {
    const r = receive(event({ subtype }))
    assert.equal(r.ok, false, `${subtype} must not become a message`)
  }
})

test('INV-slack-06 an event that is not a message is rejected by name', () => {
  const r = receive(event({ type: 'reaction_added' }))
  assert.deepEqual(r, { ok: false, because: 'not-a-message' })
})

test('INV-slack-07 an empty or whitespace-only message carries nothing to translate', () => {
  for (const text of ['', '   ', '\n\n']) {
    const r = receive(event({ text }))
    assert.deepEqual(r, { ok: false, because: 'no-text' })
  }
})

test('INV-slack-08 a thread reply keeps its thread, and a top-level message has none', () => {
  // The field is absent rather than undefined: the core's type forbids an
  // optional set to undefined, so a reply and a non-reply stay distinguishable.
  const reply = receive(event({ thread_ts: '1788325357.261719' }))
  assert.equal(reply.ok && reply.message.threadId, '1788325357.261719')

  const top = receive(event())
  assert.ok(top.ok && !('threadId' in top.message))
})

test('INV-slack-09 rejection always says which kind of event it was', () => {
  // Slack sends far more than messages down this channel and most of it is not
  // one. A silent drop is indistinguishable from a bug.
  for (const e of [event({ type: 'x' }), event({ text: '' }), event({}, ['channel'])]) {
    const r = receive(e)
    assert.equal(r.ok, false)
    assert.ok(!r.ok && r.because.length > 0)
  }
})
