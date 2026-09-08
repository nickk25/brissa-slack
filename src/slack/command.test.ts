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

/**
 * A refusal, and whether the caller can be told about it.
 *
 * `answerable` is the half worth asserting: Slack acknowledged the command
 * before any of this ran, so a refusal with nowhere to answer is a command that
 * silently did nothing.
 */
const assertRefused = (read: ReturnType<typeof readCommand>, because: string, answerable: boolean) => {
  assert.equal(read.ok, false)
  assert.ok(!read.ok && read.because === because, `${because}: got ${JSON.stringify(read)}`)
  assert.equal(!read.ok && read.responseUrl !== undefined, answerable, because)
}

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
  // Refused, and answerable: Slack acknowledged the command before any of this
  // ran, so a refusal the caller cannot hear is a command that did nothing.
  assertRefused(readCommand(payload({ text: '0' })), 'count-zero', true)
  assertRefused(readCommand(payload({ text: String(MAX_COUNT + 1) })), 'count-too-large', true)
})

test('INV-slack-66 a malformed payload, or one with nowhere to answer, is refused by name', async () => {
  // The third column is whether the caller can be told. Only the first three
  // are unanswerable, and only because the payload gave nowhere to answer.
  for (const [input, because, answerable] of [
    ['a string', 'not-a-command', false],
    [null, 'not-a-command', false],
    [payload({ response_url: undefined }), 'no-response-url', false],
    [payload({ channel_id: undefined }), 'no-channel', true],
    [payload({ user_id: undefined }), 'no-user', true],
  ] as const) {
    assertRefused(readCommand(input), because, answerable)
  }
})
