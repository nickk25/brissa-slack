/**
 * `quality.mjs`'s pure logic, run with `node --test` — no network, no API key,
 * no TypeScript compiler.
 *
 * That last part is deliberate and worth spelling out because it shapes every
 * fake in this file: `quality.mjs` has no *static* import of any `.ts` module
 * (see its header). The real `createTranslator` (`src/llm/decide.ts`) and the
 * real `hasNothingToRead` (`src/core/ask.ts`) are both reached only through a
 * dynamic `import()` inside `main()`, which never runs unless `quality.mjs` is
 * invoked directly. Importing this test file therefore never touches either
 * TypeScript module, which is what lets `node --test tools/eval/quality.test.mjs`
 * run with no flags at all — the same command a person with no `--experimental-
 * strip-types` habit would type.
 *
 * The consequence, stated plainly rather than left to be discovered: nothing
 * in this file ever calls the real `hasNothingToRead` or the real
 * `createTranslator`. Every "translator" below is a plain object with a
 * `translate` method, matching `src/core/translator.ts`'s port by shape, never
 * by import. Every `hasNothingToRead` below is a small stand-in good enough for
 * the lines these fixtures use — not a reimplementation offered as equivalent
 * to the real one, just enough to prove `findSurvivedLines` calls whatever it
 * is given at the right moments. The real functions are exercised only when
 * `quality.mjs` runs for real, which this suite never does.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findSurvivedLines, isAlreadyReadable, runCase, similarity } from './quality.mjs'

const READS = ['es', 'en']

/** Good enough for these fixtures: emoji shortcodes and nothing else. */
const stubHasNothingToRead = (line) => /^(?:\s*:[a-z0-9_+-]+:\s*)+$/i.test(line)

test('isAlreadyReadable: "Hi all." is English function words the reader reads', () => {
  assert.equal(isAlreadyReadable('Hi all.', READS), true)
})

test('isAlreadyReadable: the c-001 failure line is not majority-English or majority-Spanish', () => {
  // `sorry`, `an` and `board` are real English words, and deliberately not
  // enough on their own — this is the exact case the heuristic exists for.
  assert.equal(isAlreadyReadable('Sorry, aber wir sollten alle an board haben', READS), false)
})

test('isAlreadyReadable: a clean Spanish line reads as readable for an es/en reader', () => {
  assert.equal(isAlreadyReadable('Nos vemos todos el lunes por la mañana', READS), true)
})

test('isAlreadyReadable: an empty or punctuation-only line vouches for nothing', () => {
  assert.equal(isAlreadyReadable('', READS), false)
  assert.equal(isAlreadyReadable('...', READS), false)
})

test('isAlreadyReadable: a language with no word list cannot be vouched for', () => {
  // No Portuguese list exists below FUNCTION_WORDS, so a reader who reads only
  // Portuguese never has a line called "readable" by accident.
  assert.equal(isAlreadyReadable('Bom dia a todos', ['pt']), false)
})

test('similarity: identical strings score 1', () => {
  assert.equal(similarity('same text', 'same text'), 1)
})

test('similarity: a stray space or fixed capitalisation still scores high', () => {
  // The model reflowing whitespace is not the model translating the line.
  assert.ok(similarity('leider konnte ich nicht alle', 'leider konnte ich  nicht alle') >= 0.85)
})

test('similarity: unrelated sentences score low', () => {
  assert.ok(similarity('leider konnte ich nicht alle', 'lo siento pero no pude reunir a todos') < 0.85)
})

test('findSurvivedLines: the c-001 fixture — a German line surviving inside an otherwise Spanish translation', () => {
  // The real corpus case, `fixtures/corpus/messages.json` id `c-001`: English
  // opening, German body, and — the failure that motivated this whole file —
  // its last line came back from production untouched, in German, sitting
  // inside an otherwise Spanish translation.
  const source = [
    'Hi all.',
    'Leider konnte ich nicht alle zu einem Zeitpunkt dazu holen. daher werden wir die barcelona session 2-3 wochen verschieben bis alle wichtigen am Start sind.',
    '',
    ':smiling_face_with_tear::persevere:',
    '',
    'Alternativ würde ich aber gerne nächste Woche gerne in München zumindest eine kleine Gruppe zusammen bringen. Daran arbwite ich heute und gebe gleich Bescheid.',
    '',
    'Für Barcelona plane ich mit Persona I und komme auf euch zurueck.',
    '',
    'Sorry, aber wir sollten alle an board haben',
  ].join('\n')

  // A plausible version of the real failure: four lines genuinely translated,
  // the fifth returned exactly as it arrived.
  const translated = [
    'Hola a todos.',
    'Lamentablemente no pude reunir a todos a la vez, así que aplazaremos la sesión de Barcelona 2-3 semanas hasta que estén los importantes.',
    '',
    ':smiling_face_with_tear::persevere:',
    '',
    'Alternativamente me gustaría reunir la próxima semana al menos a un pequeño grupo en Múnich. Estoy trabajando en ello hoy y aviso enseguida.',
    '',
    'Para Barcelona cuento con Persona I y les aviso.',
    '',
    'Sorry, aber wir sollten alle an board haben',
  ].join('\n')

  const survived = findSurvivedLines({ source, translated, reads: READS, hasNothingToRead: stubHasNothingToRead })

  assert.equal(survived.length, 1)
  assert.equal(survived[0].line, 'Sorry, aber wir sollten alle an board haben')
})

test('findSurvivedLines: "Hi all." surviving is not reported — it is already readable', () => {
  const source = 'Hi all.\nLeider konnte ich nicht kommen.'
  const translated = 'Hi all.\nLamentablemente no pude venir.'
  const survived = findSurvivedLines({ source, translated, reads: READS, hasNothingToRead: stubHasNothingToRead })
  assert.deepEqual(survived, [])
})

test('findSurvivedLines: an emoji-only line surviving is not reported — hasNothingToRead skips it', () => {
  const source = 'Leider konnte ich nicht kommen.\n:smiling_face_with_tear::persevere:'
  const translated = 'Lamentablemente no pude venir.\n:smiling_face_with_tear::persevere:'
  const survived = findSurvivedLines({ source, translated, reads: READS, hasNothingToRead: stubHasNothingToRead })
  assert.deepEqual(survived, [])
})

test('findSurvivedLines: hasNothingToRead is consulted per line, not assumed', () => {
  // A stub that calls everything "nothing to read" hides every failure —
  // proving this wires the given function in rather than a hard-coded rule.
  const source = 'Sorry, aber wir sollten alle an board haben'
  const translated = 'Sorry, aber wir sollten alle an board haben'
  const alwaysNothing = () => true
  assert.deepEqual(
    findSurvivedLines({ source, translated, reads: READS, hasNothingToRead: alwaysNothing }),
    [],
  )
})

test('findSurvivedLines: a properly translated message reports nothing', () => {
  const source = 'Leider konnte ich nicht kommen.\nWir sehen uns nächste Woche.'
  const translated = 'Lamentablemente no pude venir.\nNos vemos la próxima semana.'
  const survived = findSurvivedLines({ source, translated, reads: READS, hasNothingToRead: stubHasNothingToRead })
  assert.deepEqual(survived, [])
})

test('findSurvivedLines: a very short coincidental match is not worth reporting', () => {
  // Below MIN_LINE_LENGTH — reporting this would be noise, not a finding.
  const source = 'Ok\nWir sehen uns morgen.'
  const translated = 'Ok\nNos vemos mañana.'
  const survived = findSurvivedLines({ source, translated, reads: READS, hasNothingToRead: stubHasNothingToRead })
  assert.deepEqual(survived, [])
})

/** A fake translator: `src/core/translator.ts`'s `Translator` port, by shape only. */
const fakeTranslator = (answers) => {
  let calls = 0
  return {
    async translate() {
      const next = answers[calls++] ?? answers.at(-1)
      return next
    },
  }
}

test('runCase: clean when every run comes back with nothing survived', async () => {
  const translator = fakeTranslator([
    { kind: 'translated', translation: { text: 'Nos vemos la próxima semana.', foundLanguages: ['de'] } },
  ])
  const perRun = await runCase({ text: 'Wir sehen uns nächste Woche.' }, translator, READS, 3, stubHasNothingToRead)
  assert.equal(perRun.length, 3)
  assert.ok(perRun.every((r) => r.kind === 'translated' && r.survived.length === 0))
})

test('runCase: a survived line shows up in the per-run report', async () => {
  const translator = fakeTranslator([
    { kind: 'translated', translation: { text: 'Sorry, aber wir sollten alle an board haben', foundLanguages: [] } },
  ])
  const perRun = await runCase(
    { text: 'Sorry, aber wir sollten alle an board haben' },
    translator,
    READS,
    1,
    stubHasNothingToRead,
  )
  assert.equal(perRun[0].kind, 'translated')
  assert.equal(perRun[0].survived.length, 1)
})

test('runCase: silent and failed runs are bucketed by kind, never counted as clean', () => {
  const translator = fakeTranslator([{ kind: 'silent' }, { kind: 'failed', detail: 'overloaded' }])
  return runCase({ text: 'x' }, translator, READS, 2, stubHasNothingToRead).then((perRun) => {
    assert.deepEqual(perRun, [{ kind: 'silent', detail: undefined }, { kind: 'failed', detail: 'overloaded' }])
  })
})
