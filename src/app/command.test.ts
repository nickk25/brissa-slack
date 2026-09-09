import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HistoryRead } from '../core/history.ts'
import type { Reader } from '../core/ports.ts'
import type { TranslationResult, Translator } from '../core/translator.ts'
import type { Argument, SlashCommand } from '../slack/command.ts'
import { RESPONSE_URL_BUDGET } from '../slack/shortcut.ts'
import { createMemoryDirectory } from '../store/memory.ts'
import { handleCommand, refuseCommand, TRANSLATE_COMMAND, type CommandPorts } from './command.ts'

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
    historyOwner: 'U-nick',
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

test('INV-app-57 a target that produces nothing is still answered, and says which nothing it was', async () => {
  // An empty channel, and a caller who has only ever talked to themselves —
  // both leave nothing to point a translation at. Told apart from "you can
  // already read this", because one says the reader is fine and the other says
  // there was never anything there.
  const empty = wire({ history: [] })
  assert.deepEqual(await handleCommand(empty.ports, command({ kind: 'latest' })), {
    kind: 'noticed',
    notice: 'nothing-to-translate',
  })
  assert.equal(empty.sent.length, 1)
  assert.ok(empty.sent[0]?.text.includes('no messages here from anybody else'))

  const onlySelf = wire({ history: [{ authorId: 'U-nick', text: 'talking to myself' }] })
  assert.deepEqual(await handleCommand(onlySelf.ports, command({ kind: 'latest' })), {
    kind: 'noticed',
    notice: 'nothing-to-translate',
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
  // Wherever it lands. Streaming means the successes may already be gone by the
  // time the failure is known, so what matters is that it is said at all — not
  // that it rides along with them.
  assert.ok(
    w.sent.some((m) => m.text.includes('worth trying again')),
    `no failure reported across ${w.sent.length} message(s)`,
  )

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

test('INV-app-60 a history failure is told to the caller and kept in the outcome', async () => {
  // Two audiences, two levels of detail. The caller waiting on a command gets a
  // sentence they can act on; the process keeps the Slack error, because
  // "transport: ECONNRESET" and "invalid_auth" are somebody's job and a
  // one-word kind would swallow them.
  const w = wire({ historyResult: { ok: false, detail: 'transport: ECONNRESET' } })
  assert.deepEqual(await handleCommand(w.ports, command({ kind: 'latest' })), {
    kind: 'history-failed',
    detail: 'transport: ECONNRESET',
  })
  assert.equal(w.sent.length, 1)
  assert.ok(w.sent[0]?.text.includes('Could not read this channel'))
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

test('INV-app-65 text you typed yourself is not quoted back at you', async () => {
  // The anchor exists because an ephemeral lands at the bottom of a channel with
  // nothing tying it to the message it translates. Text somebody just typed into
  // a slash command has no such problem, and quoting it back under their own
  // name is the app repeating what they said a second ago.
  const w = wire({})
  await handleCommand(w.ports, command({ kind: 'literal', text: 'Guten Morgen zusammen' }))

  const blocks = JSON.stringify(w.sent[0]?.blocks ?? [])
  assert.ok(!blocks.includes('U-nick'))
  assert.ok(!blocks.includes('&gt;'))
  assert.ok(!blocks.includes('Guten Morgen zusammen'))
})

test('INV-app-66 a message somebody else wrote still carries who wrote it', async () => {
  const w = wire({ history: [{ authorId: 'U-jens', text: GERMAN }] })
  await handleCommand(w.ports, command({ kind: 'latest' }))

  const blocks = JSON.stringify(w.sent[0]?.blocks ?? [])
  assert.ok(blocks.includes('<@U-jens>'))
})

test('INV-app-68 nobody translates a channel with somebody else’s account', async () => {
  // Brissa holds one credential. Reading with it on behalf of a second person
  // would put their command under the owner's identity in Slack's access log,
  // and the owner's channel memberships would decide what the caller can see.
  // Refused by name rather than done quietly.
  // Ana is a known reader with her own languages — the refusal is about whose
  // account does the reading, not about whether Brissa knows her.
  const ana: Reader = { userId: 'U-ana', reads: ['de'] }
  const w = wire({ readers: [nick, ana], history: [{ authorId: 'U-jens', text: GERMAN }] })
  const outcome = await handleCommand(w.ports, command({ kind: 'latest' }, { invokedBy: 'U-ana' }))

  assert.deepEqual(outcome, { kind: 'noticed', notice: 'not-your-account' })
  assert.equal(w.historyCalls(), 0)
  assert.ok(w.sent[0]?.text.includes('not yours'))
})

test('INV-app-69 an unverified account is refused too', async () => {
  // A credential whose owner nobody checked is one nobody can be told about, so
  // "we did not look" and "it is not yours" get the same answer.
  const w = wire({ history: [{ authorId: 'U-jens', text: GERMAN }] })
  const outcome = await handleCommand({ ...w.ports, historyOwner: undefined }, command({ kind: 'latest' }))

  assert.deepEqual(outcome, { kind: 'noticed', notice: 'not-your-account' })
  assert.equal(w.historyCalls(), 0)
})

test('INV-app-70 text you hand over needs no account at all', async () => {
  // The refusals above guard a channel read. Refusing to translate words
  // somebody just typed would be refusing for no reason.
  const w = wire({})
  const outcome = await handleCommand(
    { ...w.ports, history: undefined, historyOwner: undefined },
    command({ kind: 'literal', text: 'Guten Morgen zusammen' }),
  )
  assert.deepEqual(outcome, { kind: 'translated', count: 1 })
})

/** Ports whose translations finish exactly when the test says they do. */
function staged(texts: readonly string[]) {
  const sent: { blocks: readonly unknown[]; text: string }[] = []
  const release = new Map<string, () => void>()
  const gates = new Map<string, Promise<void>>()
  for (const t of texts) gates.set(t, new Promise<void>((r) => release.set(t, r)))

  const ports: CommandPorts = {
    directory: createMemoryDirectory({ readers: [nick] }),
    translator: {
      async translate(request) {
        await gates.get(request.text)
        return { kind: 'translated', translation: { text: `[${request.text}]`, foundLanguages: ['de'] } }
      },
    },
    // Newest first, the way Slack answers — `gatherSources` reverses it, so the
    // conversation arrives oldest first and `texts` reads in that order here.
    history: {
      async read() {
        return { ok: true, messages: [...texts].reverse().map((text) => ({ authorId: 'U-jens', text })) }
      },
    },
    historyOwner: 'U-nick',
    send: async (_url, r) => {
      sent.push({ blocks: r.blocks, text: r.text })
      return { ok: true }
    },
  }
  const finish = (t: string) => {
    release.get(t)?.()
    return new Promise((r) => setTimeout(r, 0))
  }
  return { ports, sent, finish }
}

const shown = (sent: readonly { blocks: readonly unknown[] }[]) =>
  sent.flatMap((m) => JSON.stringify(m.blocks).match(/\[[a-z]+\]/g) ?? [])

test('INV-app-71 a later message never overtakes an earlier one', async () => {
  // The whole risk of streaming. A conversation read out of sequence is not a
  // conversation, so a finished translation waits for every earlier one.
  const s = staged(['uno', 'dos', 'tres'])
  const running = handleCommand(s.ports, command({ kind: 'count', count: 3 }))

  // The third finishes first, and must go nowhere.
  await s.finish('tres')
  assert.deepEqual(s.sent, [])

  // The second too. Still nothing: the first is holding the line.
  await s.finish('dos')
  assert.deepEqual(s.sent, [])

  await s.finish('uno')
  await running
  assert.deepEqual(shown(s.sent), ['[uno]', '[dos]', '[tres]'])
})

test('INV-app-72 what is ready goes out without waiting for what is not', async () => {
  // The point of streaming: the first translation appears while the last is
  // still running, instead of twenty seconds of nothing.
  const s = staged(['uno', 'dos'])
  const running = handleCommand(s.ports, command({ kind: 'count', count: 2 }))

  await s.finish('uno')
  assert.deepEqual(shown(s.sent), ['[uno]'], 'the first should already be out')

  await s.finish('dos')
  await running
  assert.deepEqual(shown(s.sent), ['[uno]', '[dos]'])
})

test('INV-app-73 the last answer is reserved, so a tail can never be dropped', async () => {
  // `response_url` accepts five. A stream that spends all five on progress has
  // no way to deliver whatever is left, and the tail would vanish with nothing
  // saying so. Four go out as it fills in; the fifth carries the remainder.
  const texts = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
  const s = staged(texts)
  const running = handleCommand(s.ports, command({ kind: 'count', count: texts.length }))

  for (const t of texts) await s.finish(t)
  await running

  assert.ok(s.sent.length <= RESPONSE_URL_BUDGET.responses, `spent ${s.sent.length} answers`)
  assert.deepEqual(shown(s.sent), texts.map((t) => `[${t}]`))
})

test('INV-app-83 a command refused before it became one still answers the person who typed it', async () => {
  // This existed untested for two commits, which mutation testing found rather
  // than review: `refuseCommand` is only called from `main.ts`, and `main.ts` is
  // excluded from both the test suite and the mutation run. The bug it was
  // written to fix — a `/translate 0` that reached the operator's terminal and
  // nobody else — was fixed and then left uncovered.
  const sent: { text: string; blocks: readonly unknown[] }[] = []
  await refuseCommand('https://hooks.slack.test/x', 'count-too-large', async (_url, r) => {
    sent.push({ text: r.text, blocks: r.blocks })
    return { ok: true }
  })

  assert.equal(sent.length, 1)
  assert.ok(sent[0]?.text.includes('count-too-large'), 'the reason has to survive to the caller')
  // And it says what to do instead, because a refusal that only names the fault
  // leaves somebody guessing at the shape of the thing that would have worked.
  assert.ok(sent[0]?.text.includes('/translate'))
  assert.ok((sent[0]?.blocks.length ?? 0) > 0)
})
