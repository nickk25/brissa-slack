import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_COUNT, readCommand } from './command.ts'

const payload = (over: Record<string, unknown> = {}) => ({
  command: '/translate',
  text: '',
  channel_id: 'C-berlin',
  user_id: 'U-nick',
  response_url: 'https://hooks.slack.test/commands/T1/1/abc',
  ...over,
})

test('INV-slack-62 a slash command payload becomes the fields the app needs, defaulting to the latest message', async () => {
  const read = readCommand(payload())
  assert.ok(read.ok)
  assert.deepEqual(read.command, {
    command: '/translate',
    channelId: 'C-berlin',
    invokedBy: 'U-nick',
    argument: { kind: 'latest' },
    responseUrl: 'https://hooks.slack.test/commands/T1/1/abc',
  })
})

test('INV-slack-63 a small integer becomes a count', async () => {
  const read = readCommand(payload({ text: '5' }))
  assert.ok(read.ok && read.command.argument.kind === 'count' && read.command.argument.count === 5)

  // Surrounding whitespace is not part of the number.
  const padded = readCommand(payload({ text: '  20  ' }))
  assert.ok(padded.ok && padded.command.argument.kind === 'count' && padded.command.argument.count === MAX_COUNT)
})

test('INV-slack-64 anything else is literal text, verbatim', async () => {
  const read = readCommand(payload({ text: '5 people showed up' }))
  assert.ok(read.ok && read.command.argument.kind === 'literal' && read.command.argument.text === '5 people showed up')

  const trimmed = readCommand(payload({ text: '  Passt bei mir auch  ' }))
  assert.ok(trimmed.ok && trimmed.command.argument.kind === 'literal' && trimmed.command.argument.text === 'Passt bei mir auch')
})

test('INV-slack-65 a count of zero, or larger than the stated maximum, is refused by name', async () => {
  assert.deepEqual(readCommand(payload({ text: '0' })), { ok: false, because: 'count-zero' })
  assert.deepEqual(readCommand(payload({ text: String(MAX_COUNT + 1) })), { ok: false, because: 'count-too-large' })
})

test('INV-slack-66 a malformed payload, or one with nowhere to answer, is refused by name', async () => {
  for (const [input, because] of [
    ['a string', 'not-a-command'],
    [null, 'not-a-command'],
    [payload({ response_url: undefined }), 'no-response-url'],
    [payload({ channel_id: undefined }), 'no-channel'],
    [payload({ user_id: undefined }), 'no-user'],
  ] as const) {
    assert.deepEqual(readCommand(input), { ok: false, because }, String(because))
  }
})
