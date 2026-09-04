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

/** A model that records the whole request, not only the system prompt. */
const recording = (answers: (object | Error)[] = [{ translate: false }]) => {
  const requests: Parameters<MessagesApi['create']>[0][] = []
  let calls = 0
  const api: MessagesApi = {
    async create(request) {
      requests.push(request)
      const next = answers[calls++] ?? answers.at(-1)
      if (next instanceof Error) throw next
      return { content: [{ type: 'text', text: JSON.stringify(next) }] }
    },
  }
  return { api, requests }
}

test('INV-llm-10 the request carries the schema that makes the answer parseable at all', async () => {
  // Without `output_config` the model answers in prose and every parse fails —
  // in production, silently, as "model returned no text" for every message. No
  // test looked at this field, so any corruption of it would have shipped.
  const r = recording()
  await translator(r.api).translate(ask)

  assert.equal(r.requests.length, 1)
  assert.equal(r.requests[0]?.model, 'test')
  assert.equal(r.requests[0]?.max_tokens, 2048)
  assert.deepEqual(r.requests[0]?.output_config, {
    format: {
      type: 'json_schema',
      schema: {
        type: 'object',
        properties: {
          translate: { type: 'boolean' },
          languages: { type: 'array', items: { type: 'string' } },
          text: { type: 'string' },
        },
        required: ['translate'],
        additionalProperties: false,
      },
    },
  })
})

test('INV-llm-11 the message reaches the model as the message, unaltered', async () => {
  const r = recording()
  await translator(r.api).translate({ text: 'Hi all.\nPasst bei mir auch!', reads: ['es'] })
  assert.deepEqual(r.requests[0]?.messages, [{ role: 'user', content: 'Hi all.\nPasst bei mir auch!' }])
})

test('INV-llm-12 exactly 500 is the service saying “not now”, not “no”', async () => {
  // The boundary, not a number near it. `>= 500` and `> 500` differ on one
  // status code, and that code is the most common server error there is.
  const api = model([status(500), { translate: false }])
  assert.deepEqual(await translator(api).translate(ask), { kind: 'silent' })
  assert.equal(api.calls, 2)

  // And the other side of it: 499 is not a server error and is not retried.
  const refused = model([status(499)])
  const r = await translator(refused).translate(ask)
  assert.equal(r.kind, 'failed')
  assert.equal(refused.calls, 1)
})

test('INV-llm-13 a reply with no text block is a failure that says so', async () => {
  // The shape a tool-use-only or empty response takes. Reported rather than
  // read as silence, which is the product working correctly.
  const api: MessagesApi = { async create() { return { content: [{ type: 'thinking' }] } } }
  assert.deepEqual(await translator(api).translate(ask), {
    kind: 'failed',
    detail: 'model returned no text',
  })
})

test('INV-llm-14 a translation with no languages listed is still a translation', async () => {
  // `foundLanguages` drives the "Translated from …" line. Undefined there would
  // reach `renderTranslation` and print nothing where the source belongs.
  const r = await translator(model([{ translate: true, text: 'Me viene bien.' }])).translate(ask)
  assert.deepEqual(r, { kind: 'translated', translation: { text: 'Me viene bien.', foundLanguages: [] } })
})

test('INV-llm-15 backing off means waiting longer each time, not waiting at all', async () => {
  // A retry loop with a constant or shrinking delay is a retry loop that adds
  // load to a service already telling us it has too much.
  const waited: number[] = []
  const api = model([status(429), status(429), status(429), { translate: false }])
  await createTranslator(api, {
    model: 'test',
    promptPath: PROMPT,
    sleep: async (ms) => void waited.push(ms),
  }).translate(ask)

  assert.deepEqual(waited, [1000, 2000, 4000])
  assert.equal(api.calls, 4)
})

test('INV-llm-16 a language code with no name is shown as itself rather than dropped', async () => {
  const r = recording()
  await translator(r.api).translate({ text: 'Passt!', reads: ['xx', 'de'] })
  const system = r.requests[0]?.system ?? ''
  assert.ok(system.includes('xx and German'))
  assert.ok(!system.includes('{{READS}}'))
})
