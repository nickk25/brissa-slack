/**
 * The evaluation that runs through agents instead of the API, and the guard
 * that makes it the default. Plain `node --test`, no network, no API key.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { jobFor } from './agent-job.mjs'
import { collect } from './agent-record.mjs'
import { buildPrompt, loadCorpus, score } from './scoring.mjs'

const corpus = loadCorpus('messages')
const prompt = buildPrompt(corpus.reads, corpus.reads[0])

test('INV-llm-17 an agent is given the prompt and the words of each case, and nothing that gives the answer away', () => {
  // A corpus case carries `expected`, `languages`, `startsIn`, `categories` and
  // `note`, and every one of them is a spoiler — `languages: ['de']` already
  // says there is German to translate. An agent that can see them is not being
  // evaluated, it is being asked to read.
  const job = jobFor('messages', corpus, prompt)

  for (const c of job.cases) assert.deepEqual(Object.keys(c).sort(), ['id', 'text'])
  assert.equal(job.cases.length, corpus.cases.length)
  assert.equal(job.promptHash, prompt.hash)

  // The prompt as production builds it, with nothing left to fill in.
  assert.equal(job.system, prompt.text)
  assert.ok(!job.system.includes('{{'), 'no unfilled placeholder may reach an agent')

  // And the whole job, serialised, contains no expected answer anywhere.
  const serialised = JSON.stringify(job)
  for (const field of ['"expected"', '"languages"', '"startsIn"', '"categories"', '"note"']) {
    assert.ok(!serialised.includes(field), `${field} leaked into the job`)
  }
})

test('INV-llm-18 a case a run did not answer is never counted as agreement', () => {
  // The failure an agent makes that the API does not: skipping a case, or
  // writing something that is not a boolean. Either is a run that did not
  // measure that case, and treating it as silence would score a missing answer
  // as a correct `ignore`.
  const job = { cases: [{ id: 'a' }, { id: 'b' }] }
  const perCase = collect(job, [
    { answers: [{ id: 'a', translate: true }, { id: 'b', translate: false }] },
    { answers: [{ id: 'a', translate: true }] }, // skipped b
    { answers: [{ id: 'a', translate: true }, { id: 'b', translate: 'no' }] }, // not a boolean
  ])

  assert.deepEqual(perCase.get('a'), { answers: ['translate', 'translate', 'translate'], errors: [] })
  assert.deepEqual(perCase.get('b').answers, ['ignore'])
  assert.equal(perCase.get('b').errors.length, 2)

  const scored = score({ cases: [{ id: 'a', expected: 'translate' }, { id: 'b', expected: 'ignore' }] }, perCase, 3)
  assert.equal(scored.agreed, 1, 'b answered ignore once and was right once — that is not agreement')
  assert.equal(scored.measured, 1)

  // An id that is not in the job means the answers belong to some other job.
  assert.throws(() => collect(job, [{ answers: [{ id: 'z', translate: true }] }]), /not in this job/)
})

test('INV-llm-19 the agent route and the API route score identically', () => {
  // One `score`, used by both. The only thing that may differ between two
  // reports is how the answers were obtained — and that is recorded as `method`,
  // not left to be inferred from a number that moved.
  const perCase = new Map([
    ['x', { answers: ['translate', 'translate', 'translate'], errors: [] }],
    ['y', { answers: ['ignore', 'translate', 'ignore'], errors: [] }],
    ['z', { answers: ['ignore', 'ignore', 'ignore'], errors: [] }],
  ])
  const scored = score(
    { cases: [{ id: 'x', expected: 'translate' }, { id: 'y', expected: 'ignore' }, { id: 'z', expected: 'translate' }] },
    perCase,
    3,
  )
  assert.equal(scored.agreed, 1)
  assert.deepEqual(scored.flaky.map((f) => f.id), ['y'])
  // Kept apart: a false silence and a false translation cost different things.
  assert.deepEqual(scored.missedTranslations, ['z'])
  assert.deepEqual(scored.needlessTranslations, [])
})

test('INV-llm-20 nothing that spends API money runs without being told to', () => {
  // API spend is for real usage. Every script that can call the model refuses by
  // default and names the free route instead, so neither a person nor an agent
  // spends by habit. Exit 2 and a sentence, before any network.
  for (const [args, what] of [
    [['tools/eval/calibrate.mjs'], 'calibrate'],
    [['--experimental-strip-types', 'tools/eval/quality.mjs'], 'eval:quality'],
    [['--experimental-strip-types', 'tools/smoke.mjs', 'C1', 'hola'], 'smoke'],
  ]) {
    const run = spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, ANTHROPIC_API_KEY: '' } })
    assert.equal(run.status, 2, `${what} must refuse`)
    assert.match(run.stderr, /refused by default/, what)
    assert.match(run.stderr, /eval:agent-job/, `${what} must point at the free route`)
  }
})
