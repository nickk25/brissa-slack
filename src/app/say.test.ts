import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TranslationRequest, TranslationResult, Translator } from '../core/translator.ts'
import type { SayCommand } from '../slack/say.ts'
import { handleSay, refuseSay, SAY_COMMAND, type SayPorts } from './say.ts'

const command = (over: Partial<SayCommand> = {}): SayCommand => ({
  command: SAY_COMMAND,
  teamId: 'T1',
  invokedBy: 'U-nick',
  into: 'de',
  text: 'Hola, ¿podemos mover la reunión del martes?',
  responseUrl: 'https://hooks.slack.test/x',
  ...over,
})

const GERMAN = 'Hallo, können wir das Meeting vom Dienstag verschieben?'

function wire(answer: (r: TranslationRequest) => TranslationResult | Promise<TranslationResult>) {
  const calls: TranslationRequest[] = []
  const sent: { blocks: readonly unknown[]; text: string }[] = []
  const translator: Translator = {
    async translate(request) {
      calls.push(request)
      return await answer(request)
    },
  }
  const ports: SayPorts = {
    translator,
    send: async (_url, body) => {
      sent.push({ blocks: body.blocks, text: body.text })
      return { ok: true }
    },
  }
  return { ports, calls, sent }
}

const translated = (text: string): TranslationResult => ({
  kind: 'translated',
  translation: { text, foundLanguages: ['es'] },
})

test('INV-app-118 the translator is asked for the recipient language and the caller text, and nothing else', async () => {
  // The whole of `/say` in one assertion. If somebody ever "fixes" this to use
  // the caller's own enrolled languages, `/say` quietly becomes `/translate`
  // and every outbound message comes back in the language it was already in.
  const w = wire(() => translated(GERMAN))
  const outcome = await handleSay(w.ports, command())

  assert.deepEqual(w.calls, [{ text: 'Hola, ¿podemos mover la reunión del martes?', reads: ['de'] }])
  assert.deepEqual(outcome, { kind: 'said', into: 'de' })
  assert.equal(w.sent.length, 1)
  assert.ok(JSON.stringify(w.sent[0]?.blocks).includes(GERMAN))
})

test('INV-app-119 somebody who never ran /brissa is served', async () => {
  // There is no `Directory` in `SayPorts` at all, which is the point stated as
  // a test rather than only in prose: `/say` asks nothing about who is calling.
  // The person who needs the German is not in this workspace and never will be,
  // so there is nobody to look up — and requiring enrolment would refuse the one
  // command that needs none.
  const w = wire(() => translated(GERMAN))
  const outcome = await handleSay(w.ports, command({ invokedBy: 'U-stranger' }))

  assert.deepEqual(outcome, { kind: 'said', into: 'de' })
  assert.equal(w.calls.length, 1)
})

test('INV-app-120 nothing is posted anywhere but the caller own response_url', async () => {
  // The promise the command name does not make. `/say` reads as though it will
  // say it; it hands back text to copy. There is no path from this module to
  // `chat.postMessage` or `chat.postEphemeral`, and this is what fails if one
  // is ever added.
  let url = ''
  const posted: unknown[] = []
  const ports: SayPorts = {
    translator: { async translate() { return translated(GERMAN) } },
    send: async (to, body) => {
      url = to
      posted.push(body)
      return { ok: true }
    },
  }

  await handleSay(ports, command())

  assert.equal(url, 'https://hooks.slack.test/x')
  assert.equal(posted.length, 1, 'exactly one answer, to exactly one place')
  // And the answer says so in words, so the caller is not left assuming.
  assert.ok(JSON.stringify(posted[0]).includes('nothing was sent'))
})

test('INV-app-121 it always answers, including when there was nothing to change', async () => {
  // Three ways to end up with no translation, one rule: a command that produces
  // nothing is a broken button.

  // Already in the language they asked for. `silent` is the right answer to
  // "does this need translating" and a useless one to somebody who asked for
  // something to paste — so they get their own words back, marked as unchanged.
  const same = wire(() => ({ kind: 'silent' }))
  const unchanged = await handleSay(same.ports, command({ text: 'Guten Morgen!', into: 'de' }))
  assert.deepEqual(unchanged, { kind: 'unchanged', into: 'de' })
  assert.equal(same.sent.length, 1)
  assert.ok(JSON.stringify(same.sent[0]?.blocks).includes('Guten Morgen!'), 'their own text must come back')
  assert.ok(JSON.stringify(same.sent[0]?.blocks).includes('Already reads as German'))

  // The translator reported a failure.
  const failed = wire(() => ({ kind: 'failed', detail: 'overloaded' }))
  const toldOfFailure = await handleSay(failed.ports, command())
  assert.deepEqual(toldOfFailure, { kind: 'noticed', notice: 'translation-failed' })
  assert.equal(failed.sent.length, 1)

  // The translator threw. A port that throws is a port that failed, and the
  // caller is waiting either way.
  const threw = wire(() => { throw new Error('socket hang up') })
  const toldOfThrow = await handleSay(threw.ports, command())
  assert.deepEqual(toldOfThrow, { kind: 'noticed', notice: 'translation-failed' })
  assert.equal(threw.sent.length, 1)
})

test('INV-app-122 a command this app does not own is left alone', async () => {
  const w = wire(() => translated(GERMAN))
  const outcome = await handleSay(w.ports, command({ command: '/translate' }))

  assert.deepEqual(outcome, { kind: 'not-ours', command: '/translate' })
  assert.equal(w.calls.length, 0, 'nothing may be translated for a command we do not own')
  assert.equal(w.sent.length, 0, 'and nothing may be said about it')
})

test('INV-app-123 a payload the parser refused still reaches the person who typed it', async () => {
  // Mutation found the equivalent hole in `/translate` once: the refusal was
  // computed and never sent, so a malformed command was indistinguishable from
  // one that worked and said nothing.
  const sent: string[] = []
  const send = async (_url: string, body: { text: string }) => {
    sent.push(body.text)
    return { ok: true as const }
  }

  await refuseSay('https://hooks.slack.test/x', 'no-language', send)
  assert.equal(sent.length, 1)
  // The commonest way to use this wrong, and the fix is one character — so the
  // sentence shows the character rather than naming the error.
  assert.ok(sent[0]?.includes('/say de:'), sent[0] ?? '')

  await refuseSay('https://hooks.slack.test/x', 'no-text', send)
  assert.equal(sent.length, 2)
  assert.ok(sent[1]?.includes('/say de:'), sent[1] ?? '')

  await refuseSay('https://hooks.slack.test/x', 'no-team', send)
  assert.equal(sent.length, 3)
  assert.ok(sent[2]?.includes('no-team'), sent[2] ?? '')
})

test('INV-app-124 nothing here writes to a log', async () => {
  // The same rule the rest of `src/app` keeps: the caller's own words pass
  // through this module, and restraint is about where text can end up, not only
  // about whether Brissa speaks in a channel. `/say` carries text somebody is
  // about to send a client.
  const original = { log: console.log, error: console.error, warn: console.warn }
  const seen: unknown[] = []
  console.log = (...a: unknown[]) => void seen.push(a)
  console.error = (...a: unknown[]) => void seen.push(a)
  console.warn = (...a: unknown[]) => void seen.push(a)

  try {
    const w = wire(() => translated(GERMAN))
    await handleSay(w.ports, command())
    const failed = wire(() => ({ kind: 'failed', detail: 'overloaded' }))
    await handleSay(failed.ports, command())
  } finally {
    console.log = original.log
    console.error = original.error
    console.warn = original.warn
  }

  assert.deepEqual(seen, [])
})
