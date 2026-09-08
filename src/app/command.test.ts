import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HistoryRead } from '../core/history.ts'
import type { Reader } from '../core/ports.ts'
import type { TranslationResult, Translator } from '../core/translator.ts'
import type { Argument, SlashCommand } from '../slack/command.ts'
import { createMemoryDirectory } from '../store/memory.ts'
import { handleCommand, TRANSLATE_COMMAND, type CommandPorts } from './command.ts'

const nick: Reader = { userId: 'U-nick', reads: ['es', 'en'] }
const GERMAN = 'Passt bei mir auch, ich melde mich morgen.'
const SPANISH = 'A mí también me viene bien, te escribo mañana.'

const command = (argument: Argument, over: Partial<SlashCommand> = {}): SlashCommand => ({
  command: TRANSLATE_COMMAND,
  channelId: 'C-berlin',
  invokedBy: 'U-nick',
  argument,
  responseUrl: 'https://hooks.slack.test/x',
  ...over,
})

function wire(options: {
  readonly history?: readonly { readonly authorId: string; readonly text: string }[]
  readonly historyResult?: HistoryRead
  readonly translate?: (text: string) => TranslationResult
  readonly readers?: readonly Reader[]
}) {
  const sent: { blocks: readonly unknown[]; text: string }[] = []
  const translated: string[] = []
  let historyCalls = 0

  const translator: Translator = {
    async translate(request) {
      translated.push(request.text)
      return options.translate ? options.translate(request.text) : { kind: 'translated', translation: { text: SPANISH, foundLanguages: ['de'] } }
    },
  }

  const ports: CommandPorts = {
    directory: createMemoryDirectory({ readers: options.readers ?? [nick] }),
    translator,
    history: {
      async read() {
        historyCalls++
        if (options.historyResult) return options.historyResult
        return { ok: true, messages: options.history ?? [] }
      },
    },
    send: async (_url, r) => {
      sent.push({ blocks: r.blocks, text: r.text })
      return { ok: true }
    },
  }
  return { ports, sent, translated, historyCalls: () => historyCalls }
}

test('INV-app-54 no argument translates the most recent message that is not the caller’s own', async () => {
  const w = wire({
    history: [
      { authorId: 'U-nick', text: 'my own latest message' },
      { authorId: 'U-jens', text: GERMAN },
      { authorId: 'U-nick', text: 'older message of mine' },
    ],
  })
  const outcome = await handleCommand(w.ports, command({ kind: 'latest' }))

  assert.deepEqual(outcome, { kind: 'translated', count: 1 })
  assert.deepEqual(w.translated, [GERMAN])
})

test('INV-app-55 an explicit count translates the last N messages, including the caller’s own, oldest first', async () => {
  const w = wire({
    history: [
      { authorId: 'U-nick', text: 'newest' },
      { authorId: 'U-jens', text: 'middle' },
      { authorId: 'U-jens', text: 'oldest' },
    ],
  })
  const outcome = await handleCommand(w.ports, command({ kind: 'count', count: 3 }))

  assert.deepEqual(outcome, { kind: 'translated', count: 3 })
  // History itself returns newest first; the command reverses it so the reply
  // reads as a conversation rather than a list read backwards.
  assert.deepEqual(w.translated, ['oldest', 'middle', 'newest'])
})

test('INV-app-56 literal text is translated directly, without touching history at all', async () => {
  const w = wire({})
  const outcome = await handleCommand(w.ports, command({ kind: 'literal', text: 'Guten Morgen zusammen' }))

  assert.deepEqual(outcome, { kind: 'translated', count: 1 })
  assert.deepEqual(w.translated, ['Guten Morgen zusammen'])
  assert.equal(w.historyCalls(), 0)
})

test('INV-app-57 a target that produces nothing is still answered, not left silent', async () => {
  // An empty channel, and a caller who has only ever talked to themselves —
  // both leave nothing to point a translation at.
  const empty = wire({ history: [] })
  assert.deepEqual(await handleCommand(empty.ports, command({ kind: 'latest' })), {
    kind: 'noticed',
    notice: 'already-readable',
  })
  assert.equal(empty.sent.length, 1)

  const onlySelf = wire({ history: [{ authorId: 'U-nick', text: 'talking to myself' }] })
  assert.deepEqual(await handleCommand(onlySelf.ports, command({ kind: 'latest' })), {
    kind: 'noticed',
    notice: 'already-readable',
  })
  assert.deepEqual(onlySelf.translated, [])
})

test('INV-app-58 a translation failure among several successes stays visible, never silently dropped', async () => {
  const w = wire({
    history: [
      { authorId: 'U-jens', text: 'ok one' },
      { authorId: 'U-jens', text: 'breaks' },
    ],
    translate: (text) => (text === 'breaks' ? { kind: 'failed', detail: 'overloaded' } : { kind: 'translated', translation: { text: SPANISH, foundLanguages: ['de'] } }),
  })
  const outcome = await handleCommand(w.ports, command({ kind: 'count', count: 2 }))

  assert.deepEqual(outcome, { kind: 'translated', count: 1 })
  assert.equal(w.sent.length, 1)
  assert.ok(w.sent[0]?.text.includes('worth trying again'))

  // And when every message in the batch fails, the reply is the failure
  // notice itself rather than an empty success.
  const allFail = wire({
    history: [{ authorId: 'U-jens', text: 'breaks' }],
    translate: () => ({ kind: 'failed', detail: 'overloaded' }),
  })
  assert.deepEqual(await handleCommand(allFail.ports, command({ kind: 'count', count: 1 })), {
    kind: 'noticed',
    notice: 'translation-failed',
  })
})

test('INV-app-59 a directory failure is reported rather than answered', async () => {
  const ports: CommandPorts = {
    directory: { async lookup() { throw new Error('connection refused') } },
    translator: { async translate() { return { kind: 'silent' } } },
    history: { async read() { return { ok: true, messages: [] } } },
    send: async () => ({ ok: true }),
  }
  assert.deepEqual(await handleCommand(ports, command({ kind: 'latest' })), {
    kind: 'lookup-failed',
    detail: 'connection refused',
  })
})

test('INV-app-60 a history failure is reported rather than answered', async () => {
  const w = wire({ historyResult: { ok: false, detail: 'transport: ECONNRESET' } })
  assert.deepEqual(await handleCommand(w.ports, command({ kind: 'latest' })), {
    kind: 'history-failed',
    detail: 'transport: ECONNRESET',
  })
  assert.equal(w.sent.length, 0)
})

test('INV-app-61 somebody Brissa has never heard of is told so, not ignored', async () => {
  const w = wire({ readers: [], history: [{ authorId: 'U-jens', text: GERMAN }] })
  const outcome = await handleCommand(w.ports, command({ kind: 'latest' }))

  assert.deepEqual(outcome, { kind: 'noticed', notice: 'nobody-knows-you' })
  assert.equal(w.historyCalls(), 0)
  assert.ok(w.sent[0]?.text.includes('does not know which languages you read'))
})

test('INV-app-62 a slash command this app does not own is left alone', async () => {
  const w = wire({})
  const outcome = await handleCommand(w.ports, command({ kind: 'latest' }, { command: '/someone-elses-command' }))

  assert.deepEqual(outcome, { kind: 'not-ours', command: '/someone-elses-command' })
  assert.deepEqual(w.sent, [])
  assert.equal(w.historyCalls(), 0)
})

test('INV-app-63 an answer that could not be sent is its own outcome', async () => {
  const ports: CommandPorts = {
    directory: createMemoryDirectory({ readers: [nick] }),
    translator: { async translate() { return { kind: 'translated', translation: { text: SPANISH, foundLanguages: ['de'] } } } },
    history: { async read() { return { ok: true, messages: [{ authorId: 'U-jens', text: GERMAN }] } } },
    send: async () => ({ ok: false, detail: 'http_404' }),
  }
  assert.deepEqual(await handleCommand(ports, command({ kind: 'latest' })), {
    kind: 'unanswerable',
    detail: 'http_404',
  })
})

test('INV-app-64 nothing here writes to a log, a file, or any store', async () => {
  // The whole reason this port exists is that a message reaches only the
  // model and the caller's own screen. A console call is the cheapest place
  // that guarantee would leak from first, so a full run — lookup, history,
  // translate, reply — is spied on end to end and must make none.
  const calls: unknown[][] = []
  const original = { log: console.log, warn: console.warn, error: console.error }
  console.log = (...args: unknown[]) => calls.push(args)
  console.warn = (...args: unknown[]) => calls.push(args)
  console.error = (...args: unknown[]) => calls.push(args)
  try {
    const w = wire({ history: [{ authorId: 'U-jens', text: GERMAN }] })
    await handleCommand(w.ports, command({ kind: 'latest' }))
  } finally {
    console.log = original.log
    console.warn = original.warn
    console.error = original.error
  }
  assert.deepEqual(calls, [])
})
