import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readEnrolCommand } from './enrol.ts'

const base = { command: '/brissa', team_id: 'T1', user_id: 'U-nick', response_url: 'https://hooks.slack.com/x' }

test('INV-slack-71 no argument, empty or blank, reads as a request to see what Brissa currently thinks', () => {
  assert.deepEqual(readEnrolCommand({ ...base, text: '' }), {
    ok: true,
    command: { command: '/brissa', teamId: 'T1', invokedBy: 'U-nick', argument: { kind: 'query' }, responseUrl: base.response_url },
  })
  assert.deepEqual(readEnrolCommand({ ...base, text: '   ' }), {
    ok: true,
    command: { command: '/brissa', teamId: 'T1', invokedBy: 'U-nick', argument: { kind: 'query' }, responseUrl: base.response_url },
  })
})

test('INV-slack-72 language codes are read in the order given', () => {
  const read = readEnrolCommand({ ...base, text: 'es en' })
  assert.equal(read.ok, true)
  assert.deepEqual(read.ok && read.command.argument, { kind: 'set', reads: ['es', 'en'] })

  const reversed = readEnrolCommand({ ...base, text: 'en es' })
  assert.deepEqual(reversed.ok && reversed.command.argument, { kind: 'set', reads: ['en', 'es'] })
})

test('INV-slack-73 case and region are folded: ES, es-ES and es all mean the same language', () => {
  const read = readEnrolCommand({ ...base, text: 'ES es-ES EN-us' })
  assert.equal(read.ok, true)
  assert.deepEqual(read.ok && read.command.argument, { kind: 'set', reads: ['es', 'es', 'en'] })
})

test('INV-slack-74 a token that is not a real language code is refused, whether alone or mixed with real ones, including off used as if it were one', () => {
  assert.deepEqual(readEnrolCommand({ ...base, text: 'xyz' }), { ok: false, because: 'bad-language', responseUrl: base.response_url })
  assert.deepEqual(readEnrolCommand({ ...base, text: 'es spanish' }), {
    ok: false,
    because: 'bad-language',
    responseUrl: base.response_url,
  })
  assert.deepEqual(readEnrolCommand({ ...base, text: 'es off' }), { ok: false, because: 'bad-language', responseUrl: base.response_url })
})

test('INV-slack-75 off, in any case, alone, reads as a request to stop', () => {
  const read = readEnrolCommand({ ...base, text: 'off' })
  assert.deepEqual(read, {
    ok: true,
    command: { command: '/brissa', teamId: 'T1', invokedBy: 'U-nick', argument: { kind: 'off' }, responseUrl: base.response_url },
  })
  const shouting = readEnrolCommand({ ...base, text: 'OFF' })
  assert.deepEqual(shouting.ok && shouting.command.argument, { kind: 'off' })
})

test('INV-slack-76 a payload with nowhere to answer is refused before anything else is read', () => {
  assert.deepEqual(readEnrolCommand({ command: '/brissa', team_id: 'T1', user_id: 'U-nick', text: 'off' }), {
    ok: false,
    because: 'no-response-url',
  })
})

test('INV-slack-77 a payload with no team is refused, carrying the response_url the payload gave', () => {
  assert.deepEqual(readEnrolCommand({ command: '/brissa', user_id: 'U-nick', response_url: base.response_url, text: 'es' }), {
    ok: false,
    because: 'no-team',
    responseUrl: base.response_url,
  })
})

test('INV-slack-78 a payload with no user is refused, carrying the response_url the payload gave', () => {
  assert.deepEqual(readEnrolCommand({ command: '/brissa', team_id: 'T1', response_url: base.response_url, text: 'es' }), {
    ok: false,
    because: 'no-user',
    responseUrl: base.response_url,
  })
})

test('INV-slack-79 something not shaped like a command payload at all is refused by name', () => {
  assert.deepEqual(readEnrolCommand(null), { ok: false, because: 'not-a-command' })
  assert.deepEqual(readEnrolCommand([1, 2, 3]), { ok: false, because: 'not-a-command' })
  assert.deepEqual(readEnrolCommand('nope'), { ok: false, because: 'not-a-command' })
})
