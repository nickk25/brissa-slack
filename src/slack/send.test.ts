import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ephemeralFor, fallbackText, sendEphemeral } from './send.ts'
import type { EphemeralRequest, SlackApi } from './send.ts'
import type { InboundMessage } from '../core/ports.ts'
import type { Block } from '../core/render.ts'

const api = (response: { ok: boolean; error?: string }): SlackApi => ({
  postEphemeral: async () => response,
})

const request: EphemeralRequest = {
  channel: 'C1',
  user: 'U-nick',
  blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Me viene bien.' } }],
  text: 'Me viene bien.',
}

test('INV-slack-10 a delivered ephemeral says so', async () => {
  assert.deepEqual(await sendEphemeral(api({ ok: true }), request), { delivered: true })
})

test('INV-slack-11 a reader who was not in the channel is its own outcome, not a failure', async () => {
  // Slack only delivers an ephemeral to somebody currently in the channel, so
  // this is the expected answer for anything that arrived overnight — and the
  // reason a private shortcut is not optional.
  const out = await sendEphemeral(api({ ok: false, error: 'user_not_in_channel' }), request)
  assert.equal(out.delivered, false)
  assert.ok(!out.delivered && out.because === 'reader-not-in-channel')
})

test('INV-slack-12 a real refusal is not mistaken for absence', async () => {
  // A missing scope and a reader who stepped out look identical if both are
  // treated as "not delivered". Only one of them is somebody's job to fix.
  const out = await sendEphemeral(api({ ok: false, error: 'missing_scope' }), request)
  assert.ok(!out.delivered && out.because === 'declined' && out.detail === 'missing_scope')
})

test('INV-slack-13 a failure never reports as delivered', async () => {
  // A translation that silently failed to appear is indistinguishable, to the
  // reader, from one Brissa decided not to make.
  for (const error of ['user_not_in_channel', 'missing_scope', 'invalid_blocks', undefined]) {
    const out = await sendEphemeral(api({ ok: false, ...(error ? { error } : {}) }), request)
    assert.equal(out.delivered, false, `${error} must not read as delivered`)
    assert.ok(!out.delivered && out.detail.length > 0, 'and must say what happened')
  }
})

test('INV-slack-14 the fallback text is one line and fits a notification', async () => {
  // Slack shows it in the push notification; omitting it makes the notification
  // read "This content can't be displayed".
  const long = fallbackText('a'.repeat(400))
  assert.ok(long.length <= 120)
  assert.equal(fallbackText('two\n\nlines  here'), 'two lines here')
})

test('INV-slack-15 a short translation is not truncated', async () => {
  assert.equal(fallbackText('Me viene bien.'), 'Me viene bien.')
})

const inbound: InboundMessage = {
  channelId: 'C-berlin',
  authorId: 'U-jens',
  fromBot: false,
  text: 'Passt bei mir auch!',
}
const blocks: readonly Block[] = [{ type: 'section', text: { type: 'mrkdwn', text: 'Me viene bien.' } }]

test('INV-slack-16 a translation is addressed to one channel and one reader', async () => {
  const built = ephemeralFor(inbound, 'U-nick', blocks, 'Me viene bien.')
  assert.equal(built.channel, 'C-berlin')
  assert.equal(built.user, 'U-nick')
  assert.equal(built.blocks, blocks)
})

test('INV-slack-17 our thread becomes Slack’s thread here, and nowhere else', async () => {
  // `receive` renames `thread_ts` on the way in. Without the matching rename on
  // the way out, that Slack field name would live in the wiring — the exact
  // knowledge this boundary exists to contain.
  const threaded = ephemeralFor({ ...inbound, threadId: '1699.9' }, 'U-nick', blocks, 'Me viene bien.')
  assert.equal(threaded.thread_ts, '1699.9')

  // Absent, not undefined: Slack reads a present-but-empty `thread_ts` as a
  // malformed request rather than as a top-level post.
  const top = ephemeralFor(inbound, 'U-nick', blocks, 'Me viene bien.')
  assert.ok(!('thread_ts' in top))
})

test('INV-slack-18 the notification carries the translation, truncated, not the blocks', async () => {
  const long = 'Sí,\n\nme viene bien. '.repeat(20)
  const built = ephemeralFor(inbound, 'U-nick', blocks, long)
  assert.equal(built.text, fallbackText(long))
  assert.ok(built.text.length <= 120)
  assert.ok(built.text.endsWith('…'))
})
