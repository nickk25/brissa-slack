import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Reader } from '../core/ports.ts'
import type { TranslationResult, Translator } from '../core/translator.ts'
import type { Shortcut } from '../slack/shortcut.ts'
import { createMemoryDirectory } from '../store/memory.ts'
import { handleShortcut, TRANSLATE, type ShortcutPorts } from './shortcut.ts'

const nick: Reader = { userId: 'U-nick', reads: ['es', 'en'] }
const GERMAN = 'Passt bei mir auch, ich melde mich morgen.'
const SPANISH = 'A mí también me viene bien, te escribo mañana.'

const shortcut = (over: Partial<Shortcut> = {}): Shortcut => ({
  callbackId: TRANSLATE,
  channelId: 'C-berlin',
  invokedBy: 'U-nick',
  authorId: 'U-jens',
  text: GERMAN,
  responseUrl: 'https://hooks.slack.test/x',
  ...over,
})

function wire(reply: () => TranslationResult, readers: readonly Reader[] = [nick]) {
  const sent: { blocks: readonly unknown[]; text: string }[] = []
  const calls: string[] = []
  const translator: Translator = {
    async translate(request) {
      calls.push(request.text)
      return reply()
    },
  }
  const ports: ShortcutPorts = {
    // Deliberately a channel with no policy at all: the shortcut has to work in
    // channels Brissa was never switched on in, which is its entire purpose.
    directory: createMemoryDirectory({ readers }),
    translator,
    send: async (_url, r) => {
      sent.push({ blocks: r.blocks, text: r.text })
      return { ok: true }
    },
  }
  return { ports, sent, calls }
}

test('INV-app-45 a channel Brissa was never switched on in is still translated on request', async () => {
  // The whole point. `shouldAsk` would refuse this for `channel-disabled`, and
  // the shortcut must not consult it: it works in channels Brissa cannot see.
  const w = wire(() => ({ kind: 'translated', translation: { text: SPANISH, foundLanguages: ['de'] } }))
  const outcome = await handleShortcut(w.ports, shortcut())

  assert.deepEqual(outcome, { kind: 'translated' })
  assert.deepEqual(w.calls, [GERMAN])
  assert.equal(w.sent.length, 1)
  assert.ok(JSON.stringify(w.sent[0]?.blocks).includes('U-jens'))
})

test('INV-app-46 your own message is translated when you ask for it', async () => {
  // `own-message` exists so Brissa never hands back your words unprompted. A
  // click is a prompt.
  const w = wire(() => ({ kind: 'translated', translation: { text: SPANISH, foundLanguages: ['de'] } }))
  const outcome = await handleShortcut(w.ports, shortcut({ authorId: 'U-nick' }))
  assert.deepEqual(outcome, { kind: 'translated' })
})

test('INV-app-47 a click always gets an answer, even when there is nothing to translate', async () => {
  // On the automatic path silence is the product. Here it is a broken button.
  const w = wire(() => ({ kind: 'silent' }))
  const outcome = await handleShortcut(w.ports, shortcut())

  assert.deepEqual(outcome, { kind: 'noticed', notice: 'already-readable' })
  assert.equal(w.sent.length, 1)
  assert.ok(w.sent[0]?.text.includes('already in a language you read'))
})

test('INV-app-48 a failure is told to the person waiting on it', async () => {
  const failed = wire(() => ({ kind: 'failed', detail: 'overloaded' }))
  assert.deepEqual(await handleShortcut(failed.ports, shortcut()), {
    kind: 'noticed',
    notice: 'translation-failed',
  })
  assert.equal(failed.sent.length, 1)

  // Same for a port that throws rather than returning a failure.
  const threw = wire(() => {
    throw new Error('socket hang up')
  })
  assert.deepEqual(await handleShortcut(threw.ports, shortcut()), {
    kind: 'noticed',
    notice: 'translation-failed',
  })
  assert.equal(threw.sent.length, 1)
})

test('INV-app-49 somebody Brissa has never heard of is told so, not ignored', async () => {
  // The first thing a new person does is click the button. Being met with
  // nothing at all would be indistinguishable from the app being broken.
  const unknown = wire(() => ({ kind: 'silent' }), [])
  const outcome = await handleShortcut(unknown.ports, shortcut())

  assert.deepEqual(outcome, { kind: 'noticed', notice: 'nobody-knows-you' })
  assert.deepEqual(unknown.calls, [])
  assert.ok(unknown.sent[0]?.text.includes('does not know which languages you read'))

  // And the same for somebody enrolled with no languages, which is the shape of
  // a half-finished setup.
  const empty = wire(() => ({ kind: 'silent' }), [{ userId: 'U-nick', reads: [] }])
  assert.deepEqual(await handleShortcut(empty.ports, shortcut()), {
    kind: 'noticed',
    notice: 'nobody-knows-you',
  })
  assert.deepEqual(empty.calls, [])
})

test('INV-app-50 the reader is whoever clicked, not whoever is in the channel', async () => {
  // The answer goes to one person by construction, so the languages must be
  // theirs. Another enrolled reader nearby is irrelevant.
  const ana: Reader = { userId: 'U-ana', reads: ['de'] }
  const w = wire(() => ({ kind: 'translated', translation: { text: SPANISH, foundLanguages: ['de'] } }), [ana, nick])
  await handleShortcut(w.ports, shortcut({ invokedBy: 'U-nick' }))
  assert.deepEqual(w.calls, [GERMAN])
  assert.equal(w.sent.length, 1)
})

test('INV-app-51 a shortcut this app does not own is left alone', async () => {
  // Another app's callback id arriving here would otherwise be answered with a
  // translation nobody asked for.
  const w = wire(() => ({ kind: 'silent' }))
  const outcome = await handleShortcut(w.ports, shortcut({ callbackId: 'someone_elses_button' }))

  assert.deepEqual(outcome, { kind: 'not-ours', callbackId: 'someone_elses_button' })
  assert.deepEqual(w.sent, [])
  assert.deepEqual(w.calls, [])
})

test('INV-app-52 an answer that could not be sent is its own outcome', async () => {
  // Distinct from having nothing to say. One is the product working; the other
  // is a reader left staring at a button that did nothing.
  const ports: ShortcutPorts = {
    directory: createMemoryDirectory({ readers: [nick] }),
    translator: { async translate() { return { kind: 'silent' } } },
    send: async () => ({ ok: false, detail: 'http_404' }),
  }
  assert.deepEqual(await handleShortcut(ports, shortcut()), { kind: 'unanswerable', detail: 'http_404' })
})

test('INV-app-53 a directory that breaks is reported rather than answered', async () => {
  const ports: ShortcutPorts = {
    directory: { async lookup() { throw new Error('connection refused') } },
    translator: { async translate() { return { kind: 'silent' } } },
    send: async () => ({ ok: true }),
  }
  assert.deepEqual(await handleShortcut(ports, shortcut()), {
    kind: 'lookup-failed',
    detail: 'connection refused',
  })
})
