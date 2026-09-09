import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Enrolment, EnrolmentRecord } from '../core/enrolment.ts'
import type { EnrolArgument, EnrolCommand } from '../slack/enrol.ts'
import { ENROL_COMMAND, handleEnrol, type EnrolPorts } from './enrol.ts'

const command = (argument: EnrolArgument, over: Partial<EnrolCommand> = {}): EnrolCommand => ({
  command: ENROL_COMMAND,
  teamId: 'T1',
  invokedBy: 'U-nick',
  argument,
  responseUrl: 'https://hooks.slack.test/x',
  ...over,
})

function wire(options: {
  readonly initial?: Record<string, EnrolmentRecord>
  readonly readThrows?: Error
  readonly writeThrows?: Error
  readonly sendFails?: string
}) {
  const store: Record<string, EnrolmentRecord> = { ...(options.initial ?? {}) }
  const writes: EnrolmentRecord[] = []

  const enrolment: Enrolment = {
    async read(teamId, userId) {
      if (options.readThrows) throw options.readThrows
      return store[`${teamId}:${userId}`]
    },
    async write(record) {
      if (options.writeThrows) throw options.writeThrows
      writes.push(record)
      store[`${record.teamId}:${record.userId}`] = record
    },
  }

  const sent: { blocks: readonly unknown[]; text: string }[] = []
  const ports: EnrolPorts = {
    enrolment,
    send: async (_url, r) => {
      if (options.sendFails) return { ok: false, detail: options.sendFails }
      sent.push({ blocks: r.blocks, text: r.text })
      return { ok: true }
    },
  }
  return { ports, sent, writes, store }
}

test('INV-app-74 a bare /brissa reports what Brissa currently thinks the caller reads, in order', async () => {
  const w = wire({ initial: { 'T1:U-nick': { teamId: 'T1', userId: 'U-nick', reads: ['es', 'en'] } } })
  const outcome = await handleEnrol(w.ports, command({ kind: 'query' }))

  assert.deepEqual(outcome, { kind: 'reported', status: { kind: 'enrolled', reads: ['es', 'en'] } })
  assert.equal(w.sent.length, 1)
  // Named, not coded. Somebody answered "es, then en" has been shown their own
  // input back; "Spanish, then English" is Brissa saying what it understood.
  assert.match(w.sent[0]?.text ?? '', /Spanish, then English/)
})

test('INV-app-75 a bare /brissa for somebody never enrolled says so, distinct from off', async () => {
  const w = wire({})
  const outcome = await handleEnrol(w.ports, command({ kind: 'query' }))

  assert.deepEqual(outcome, { kind: 'reported', status: { kind: 'never-enrolled' } })
  assert.match(w.sent[0]?.text ?? '', /does not know which languages/)
})

test('INV-app-76 a bare /brissa for somebody who turned off translation says so, distinct from never-enrolled', async () => {
  const w = wire({ initial: { 'T1:U-nick': { teamId: 'T1', userId: 'U-nick', reads: [] } } })
  const outcome = await handleEnrol(w.ports, command({ kind: 'query' }))

  assert.deepEqual(outcome, { kind: 'reported', status: { kind: 'off' } })
  assert.match(w.sent[0]?.text ?? '', /not translating for you right now/)
  assert.notDeepEqual(outcome, { kind: 'reported', status: { kind: 'never-enrolled' } })
})

test('INV-app-77 /brissa es en saves the languages, in order, and confirms them in words', async () => {
  const w = wire({})
  const outcome = await handleEnrol(w.ports, command({ kind: 'set', reads: ['es', 'en'] }))

  assert.deepEqual(outcome, { kind: 'saved', reads: ['es', 'en'] })
  assert.deepEqual(w.writes, [{ teamId: 'T1', userId: 'U-nick', reads: ['es', 'en'] }])
  assert.match(w.sent[0]?.text ?? '', /Saved.*Spanish, then English/)
})

test('INV-app-78 /brissa off writes an empty enrolment and confirms translation has stopped', async () => {
  const w = wire({ initial: { 'T1:U-nick': { teamId: 'T1', userId: 'U-nick', reads: ['es'] } } })
  const outcome = await handleEnrol(w.ports, command({ kind: 'off' }))

  assert.deepEqual(outcome, { kind: 'stopped' })
  // The same empty list `shouldAsk` already reads as "stay silent for this
  // reader" — off is not a second mechanism, it is that one reused.
  assert.deepEqual(w.writes, [{ teamId: 'T1', userId: 'U-nick', reads: [] }])
  assert.match(w.sent[0]?.text ?? '', /stop translating for you/)
})

test('INV-app-79 a command this app does not own is left alone', async () => {
  const w = wire({})
  const outcome = await handleEnrol(w.ports, command({ kind: 'query' }, { command: '/translate' }))

  assert.deepEqual(outcome, { kind: 'not-ours', command: '/translate' })
  assert.deepEqual(w.sent, [])
  assert.deepEqual(w.writes, [])
})

test('INV-app-80 a store failure is reported as its own outcome, never answered as if nothing were on file', async () => {
  const readFailure = wire({ readThrows: new Error('disk on fire') })
  const readOutcome = await handleEnrol(readFailure.ports, command({ kind: 'query' }))
  assert.deepEqual(readOutcome, { kind: 'store-failed', detail: 'disk on fire' })
  assert.deepEqual(readFailure.sent, [])

  const writeFailure = wire({ writeThrows: new Error('disk on fire') })
  const writeOutcome = await handleEnrol(writeFailure.ports, command({ kind: 'set', reads: ['es'] }))
  assert.deepEqual(writeOutcome, { kind: 'store-failed', detail: 'disk on fire' })
  assert.deepEqual(writeFailure.sent, [])
})

test('INV-app-81 an answer that could not be sent is its own outcome, distinct from having nothing to say', async () => {
  const w = wire({ sendFails: 'http_500' })
  const outcome = await handleEnrol(w.ports, command({ kind: 'set', reads: ['es'] }))

  assert.deepEqual(outcome, { kind: 'unanswerable', detail: 'http_500' })
  // The write still happened; only the reply failed to arrive.
  assert.deepEqual(w.writes, [{ teamId: 'T1', userId: 'U-nick', reads: ['es'] }])
})

test('INV-app-82 nothing here writes to a log, a file, or any store outside Enrolment', async () => {
  // The whole reason this port exists is that a person's languages go nowhere
  // but the store they asked to be written to and the reply only they see. A
  // console call is the cheapest place that guarantee would leak from first.
  const calls: unknown[][] = []
  const original = { log: console.log, warn: console.warn, error: console.error }
  console.log = (...args: unknown[]) => calls.push(args)
  console.warn = (...args: unknown[]) => calls.push(args)
  console.error = (...args: unknown[]) => calls.push(args)
  try {
    const w = wire({ initial: { 'T1:U-nick': { teamId: 'T1', userId: 'U-nick', reads: ['es'] } } })
    await handleEnrol(w.ports, command({ kind: 'query' }))
    await handleEnrol(w.ports, command({ kind: 'set', reads: ['es', 'en'] }))
    await handleEnrol(w.ports, command({ kind: 'off' }))
  } finally {
    console.log = original.log
    console.warn = original.warn
    console.error = original.error
  }
  assert.deepEqual(calls, [])
})

test('INV-app-117 no hint shows an example that would opt the reader out of a language', async () => {
  // Naming a language is how somebody says *do not translate this for me*. The
  // hints used to offer `/brissa es en` as the example, so a person following
  // the suggestion literally silenced English for good — and one did, then
  // reported that Brissa "was not translating English", which was Brissa doing
  // exactly what they had been told to ask for.
  //
  // Asserted across every hint rather than the one that was reported, because
  // there were three copies of it and only one was noticed.
  const hints: string[] = []

  const never = wire({})
  await handleEnrol(never.ports, command({ kind: 'query' }))
  hints.push(never.sent[0]?.text ?? '')

  const off = wire({ initial: { 'T1:U-nick': { teamId: 'T1', userId: 'U-nick', reads: [] } } })
  await handleEnrol(off.ports, command({ kind: 'query' }))
  hints.push(off.sent[0]?.text ?? '')

  assert.equal(hints.length, 2)
  for (const hint of hints) {
    assert.ok(hint.includes('/brissa'), hint)
    // The specific shape that caused it: an example listing a second language.
    assert.doesNotMatch(hint, /`\/brissa( [a-z]{2}){2,}/, `this hint tells somebody to opt out: ${hint}`)
  }

  // And the one that is allowed to list two is the confirmation, because by
  // then the person has said it themselves rather than been shown it.
  const saved = wire({})
  await handleEnrol(saved.ports, command({ kind: 'set', reads: ['es', 'en'] }))
  assert.match(saved.sent[0]?.text ?? '', /Spanish, then English/)
})
