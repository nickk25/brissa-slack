import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fallbackText, sendEphemeral } from './send.ts'
import type { EphemeralRequest, SlackApi } from './send.ts'

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
