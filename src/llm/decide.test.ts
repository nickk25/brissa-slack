import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { createTranslator } from './decide.ts'
import type { MessagesApi } from './decide.ts'

const PROMPT = join(process.cwd(), 'src/llm/prompts/decide.md')

/** A model that answers with whatever it was handed, or throws it. */
const model = (answers: (object | Error)[]): MessagesApi & { calls: number; systems: string[] } => {
  const api = {
    calls: 0,
    systems: [] as string[],
    async create(request: Parameters<MessagesApi['create']>[0]) {
      api.systems.push(request.system)
      const next = answers[api.calls++] ?? answers.at(-1)
      if (next instanceof Error) throw next
      return { content: [{ type: 'text', text: JSON.stringify(next) }] }
    },
  }
  return api
}

const status = (code: number): Error => Object.assign(new Error(`HTTP ${code}`), { status: code })
const translator = (api: MessagesApi, over: Partial<Parameters<typeof createTranslator>[1]> = {}) =>
  createTranslator(api, { model: 'test', promptPath: PROMPT, sleep: async () => {}, ...over })

const ask = { text: 'Passt bei mir auch!', reads: ['es', 'en'] }

test('INV-llm-01 a translation comes back as one, with the languages it found', async () => {
  const r = await translator(model([{ translate: true, languages: ['de'], text: 'Me viene bien.' }])).translate(ask)
  assert.deepEqual(r, { kind: 'translated', translation: { text: 'Me viene bien.', foundLanguages: ['de'] } })
})

test('INV-llm-02 a decision not to translate is silence, not a failure', async () => {
  // Staying quiet is this product's normal behaviour. If it read as a failure,
  // the state page would show an outage every time Brissa worked correctly.
  const r = await translator(model([{ translate: false }])).translate(ask)
  assert.deepEqual(r, { kind: 'silent' })
})

test('INV-llm-03 silence and failure are never the same outcome', async () => {
  // The confusion this product cannot afford: an outage that looks like
  // restraint, in a product whose main behaviour is restraint.
  const failed = await translator(model([status(400)])).translate(ask)
  assert.equal(failed.kind, 'failed')
  assert.notEqual(failed.kind, 'silent')
})

test('INV-llm-04 asked to translate but given no text is a failure, not silence', async () => {
  // A broken answer wearing the shape of a quiet one. Reporting it as silence
  // would hide the fault behind the product working as intended.
  const r = await translator(model([{ translate: true, languages: ['de'] }])).translate(ask)
  assert.equal(r.kind, 'failed')
})

test('INV-llm-05 a transient failure is retried and can still succeed', async () => {
  // A 529 is the service saying "not now". Six of twenty-eight cases were lost
  // to exactly this before anything retried.
  const api = model([status(529), status(529), { translate: true, languages: ['de'], text: 'ok' }])
  const r = await translator(api).translate(ask)
  assert.equal(r.kind, 'translated')
  assert.equal(api.calls, 3)
})

test('INV-llm-06 a refusal is not retried', async () => {
  // Repeating a request the service already refused only delays the report of a
  // real problem, and spends money doing it.
  const api = model([status(400)])
  await translator(api).translate(ask)
  assert.equal(api.calls, 1)
})

test('INV-llm-07 retrying gives up rather than looping forever', async () => {
  const api = model([status(529)])
  const r = await translator(api, { attempts: 3 }).translate(ask)
  assert.equal(r.kind, 'failed')
  assert.equal(api.calls, 3)
})

test('INV-llm-08 the reader’s languages reach the model by name, not as codes', async () => {
  // The prompt is written in English about languages; `de` is not a word it can
  // reason about.
  const api = model([{ translate: false }])
  await translator(api).translate({ text: 'x', reads: ['es', 'en'] })
  assert.match(api.systems[0] ?? '', /Spanish and English/)
  assert.doesNotMatch(api.systems[0] ?? '', /\{\{READS\}\}/)
})

test('INV-llm-09 a reader with no languages is a failure, never a guess', async () => {
  // The core is meant to have stopped this. Inventing a target language would be
  // a worse answer than saying the caller skipped a step.
  const api = model([{ translate: false }])
  const r = await translator(api).translate({ text: 'x', reads: [] })
  assert.equal(r.kind, 'failed')
  assert.equal(api.calls, 0, 'and it costs nothing to find out')
})
