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
 * to the real one, just enough to prove `findSurvivedLines` and `runCase` call
 * whatever they are given at the right moments. The real functions are
 * exercised only when `quality.mjs` runs for real, which this suite never does.
 *
 * There used to be a fourth kind of fake here: a function-word heuristic,
 * `isAlreadyReadable`, that tried to tell a correctly-kept line from a failed
 * one by counting closed-class words. It is gone, along with its tests — it
 * was wrong on ordinary sentences (see `docs/DECISIONS.md`) and nothing in
 * this file argues for tuning it back in. What replaced it is a second call to
 * the same translator fake this suite already builds, asking about one
 * surviving line at a time — so the fakes below model exactly two calls a real
 * run makes: one for the whole message, one per line that survived it.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findSurvivedLines, probeSurvivedLine, runCase, similarity } from './quality.mjs'

const READS = ['es', 'en']

/** Good enough for these fixtures: emoji shortcodes and nothing else. */
const stubHasNothingToRead = (line) => /^(?:\s*:[a-z0-9_+-]+:\s*)+$/i.test(line)

/**
 * A fake translator: `src/core/translator.ts`'s `Translator` port, by shape
 * only. `answers` is consumed one call at a time, in order — for `runCase`
 * that means the first call is the whole-message translate, and every call
 * after it is a probe of one surviving line — and the last answer repeats for
 * any call beyond the list, so a test only needs to spell out what changes.
 */
const fakeTranslator = (answers) => {
  let calls = 0
  return {
    async translate() {
      const next = answers[calls++] ?? answers.at(-1)
      return next
    },
  }
}

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

test('findSurvivedLines: a line that reappears unchanged is a candidate, whatever language it is in', () => {
  // No `isAlreadyReadable` filter left to exempt "Hi all." here — every
  // verbatim survivor is now a candidate, and it is `probeSurvivedLine` (via
  // `runCase`), never this function, that decides whether it was a failure.
  const source = 'Hi all.\nLeider konnte ich nicht kommen.'
  const translated = 'Hi all.\nLamentablemente no pude venir.'
  const survived = findSurvivedLines({ source, translated, reads: READS, hasNothingToRead: stubHasNothingToRead })
  assert.deepEqual(survived.map((s) => s.line), ['Hi all.'])
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

  // `Hi all.` came back as `Hola a todos.` here — genuinely translated, not a
  // candidate. Only the untouched German line survived.
  assert.deepEqual(survived.map((s) => s.line), ['Sorry, aber wir sollten alle an board haben'])
})

test('findSurvivedLines: an emoji-only line surviving is not reported — hasNothingToRead skips it', () => {
  const source = 'Leider konnte ich nicht kommen.\n:smiling_face_with_tear::persevere:'
  const translated = 'Lamentablemente no pude venir.\n:smiling_face_with_tear::persevere:'
  const survived = findSurvivedLines({ source, translated, reads: READS, hasNothingToRead: stubHasNothingToRead })
  assert.deepEqual(survived, [])
})

test('findSurvivedLines: hasNothingToRead is consulted per line, not assumed', () => {
  // A stub that calls everything "nothing to read" hides every candidate —
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

test('probeSurvivedLine: the translator staying silent on the line means it was right to survive', async () => {
  const translator = fakeTranslator([{ kind: 'silent' }])
  const result = await probeSurvivedLine('Hi all.', translator, READS)
  assert.deepEqual(result, { line: 'Hi all.', verdict: 'readable' })
})

test('probeSurvivedLine: the translator translating the line means it should not have survived', async () => {
  const translator = fakeTranslator([
    { kind: 'translated', translation: { text: 'Perdón, pero deberíamos tener a todos a bordo', foundLanguages: ['de'] } },
  ])
  const result = await probeSurvivedLine('Sorry, aber wir sollten alle an board haben', translator, READS)
  assert.deepEqual(result, { line: 'Sorry, aber wir sollten alle an board haben', verdict: 'flagged' })
})

test('probeSurvivedLine: a failed probe is reported as its own thing, never silently readable', async () => {
  const translator = fakeTranslator([{ kind: 'failed', detail: 'overloaded' }])
  const result = await probeSurvivedLine('some line', translator, READS)
  assert.deepEqual(result, { line: 'some line', verdict: 'unmeasured', detail: 'overloaded' })
})

test('runCase: c-001 — the German line survives and the probe says translated, so it is flagged', async () => {
  const source = [
    'Hi all.',
    'Leider konnte ich nicht alle zu einem Zeitpunkt dazu holen.',
    '',
    ':smiling_face_with_tear::persevere:',
    '',
    'Sorry, aber wir sollten alle an board haben',
  ].join('\n')
  // `Hi all.` genuinely translated here, same as the real case in
  // `fixtures/corpus/messages.json`'s c-001 — only the last line comes back
  // untouched.
  const translated = [
    'Hola a todos.',
    'Lamentablemente no pude reunir a todos a la vez.',
    '',
    ':smiling_face_with_tear::persevere:',
    '',
    'Sorry, aber wir sollten alle an board haben',
  ].join('\n')

  const translator = fakeTranslator([
    // Call 1: the whole-message translate.
    { kind: 'translated', translation: { text: translated, foundLanguages: ['de'] } },
    // Call 2: probing the one line that survived — the German closing line.
    // Asked about it on its own, the model would translate it, so this is
    // the real failure: it should have come back translated the first time.
    { kind: 'translated', translation: { text: 'Perdón, pero deberíamos tener a todos a bordo', foundLanguages: ['de'] } },
  ])

  const perRun = await runCase({ text: source }, translator, READS, 1, stubHasNothingToRead)

  assert.equal(perRun.length, 1)
  assert.equal(perRun[0].kind, 'translated')
  assert.deepEqual(perRun[0].survived, [
    { line: 'Sorry, aber wir sollten alle an board haben', verdict: 'flagged' },
  ])
})

test('runCase: "Hi all." surviving a Spanish/English message is not flagged — the probe says silent', async () => {
  const source = 'Hi all.\nLeider konnte ich nicht kommen.'
  const translated = 'Hi all.\nLamentablemente no pude venir.'
  const translator = fakeTranslator([
    // Call 1: the whole-message translate — the German line translated, the
    // English greeting left exactly as it arrived.
    { kind: 'translated', translation: { text: translated, foundLanguages: ['de'] } },
    // Call 2: probing the survived "Hi all." on its own — the reader reads
    // English, so the model stays silent on it. It was right to survive.
    { kind: 'silent' },
  ])
  const perRun = await runCase({ text: source }, translator, READS, 1, stubHasNothingToRead)
  assert.equal(perRun[0].kind, 'translated')
  assert.deepEqual(perRun[0].survived, [{ line: 'Hi all.', verdict: 'readable' }])
})

test('runCase: a pure Spanish sentence surviving is not flagged when the probe says silent', async () => {
  // The old function-word heuristic flagged this outright: three content
  // words is enough to sink a sentence under a 50% function-word bar, even
  // though this is exactly the reader's own language. `Perfecto, nos vemos
  // el viernes.` is `docs/DECISIONS.md`'s own example of that failure.
  const line = 'Perfecto, nos vemos el viernes.'
  const translator = fakeTranslator([
    { kind: 'translated', translation: { text: line, foundLanguages: [] } },
    { kind: 'silent' },
  ])
  const perRun = await runCase({ text: line }, translator, READS, 1, stubHasNothingToRead)
  assert.equal(perRun[0].kind, 'translated')
  assert.deepEqual(perRun[0].survived, [{ line, verdict: 'readable' }])
})

test('runCase: a pure English sentence surviving is not flagged when the probe says silent', async () => {
  // The other sentence the old heuristic got wrong, for the same reason: a
  // technical sentence has few function words no matter how readable it is.
  const line = 'Can you review the deployment pipeline configuration?'
  const translator = fakeTranslator([
    { kind: 'translated', translation: { text: line, foundLanguages: [] } },
    { kind: 'silent' },
  ])
  const perRun = await runCase({ text: line }, translator, READS, 1, stubHasNothingToRead)
  assert.equal(perRun[0].kind, 'translated')
  assert.deepEqual(perRun[0].survived, [{ line, verdict: 'readable' }])
})

test('runCase: a probe that fails is bucketed as unmeasured, never counted as clean by silently disappearing', async () => {
  const line = 'Sorry, aber wir sollten alle an board haben'
  const translator = fakeTranslator([
    { kind: 'translated', translation: { text: line, foundLanguages: ['de'] } },
    { kind: 'failed', detail: 'overloaded' },
  ])
  const perRun = await runCase({ text: line }, translator, READS, 1, stubHasNothingToRead)
  assert.equal(perRun[0].kind, 'translated')
  assert.deepEqual(perRun[0].survived, [{ line, verdict: 'unmeasured', detail: 'overloaded' }])
  // Not "flagged", and not silently absent either — it is its own verdict,
  // distinguishable from both a clean pass and a confirmed failure.
  assert.notEqual(perRun[0].survived[0].verdict, 'flagged')
  assert.notEqual(perRun[0].survived[0].verdict, 'readable')
})

test('runCase: no probe call is made for a line hasNothingToRead already rejects', async () => {
  const source = 'Leider konnte ich nicht kommen.\n:smiling_face_with_tear::persevere:'
  const translated = 'Lamentablemente no pude venir.\n:smiling_face_with_tear::persevere:'
  let translateCalls = 0
  const translator = {
    async translate() {
      translateCalls++
      // First call is the whole-message translate; anything past that would
      // be a probe. There is exactly one candidate line here — the emoji
      // line is rejected by hasNothingToRead before it ever reaches a probe —
      // and that line is a clean match, so no probe is needed for it either.
      return { kind: 'translated', translation: { text: translated, foundLanguages: ['de'] } }
    },
  }
  const perRun = await runCase({ text: source }, translator, READS, 1, stubHasNothingToRead)
  assert.equal(translateCalls, 1) // only the whole-message call — nothing survived to probe
  assert.equal(perRun[0].kind, 'translated')
  assert.deepEqual(perRun[0].survived, [])
})

test('runCase: silent and failed top-level runs are bucketed by kind, never counted as clean', () => {
  const translator = fakeTranslator([{ kind: 'silent' }, { kind: 'failed', detail: 'overloaded' }])
  return runCase({ text: 'x' }, translator, READS, 2, stubHasNothingToRead).then((perRun) => {
    assert.deepEqual(perRun, [{ kind: 'silent', detail: undefined }, { kind: 'failed', detail: 'overloaded' }])
  })
})
