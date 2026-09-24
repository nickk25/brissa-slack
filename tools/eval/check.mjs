#!/usr/bin/env node
/**
 * Has this prompt actually been evaluated?
 *
 * `coupling.yaml` demands this whenever a prompt changes. It is a `command`
 * requirement rather than a `changed` one on purpose: asking "did somebody edit
 * the eval result" proves nothing, while asking "does a recorded result exist
 * for *this* prompt" cannot be satisfied by typing.
 *
 * Every recorded run carries the hash of the prompt it ran against, so editing
 * the prompt invalidates every existing result by construction. There is no way
 * to reuse an old score for a new prompt except by running it again.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const PROMPTS = join(ROOT, 'src/llm/prompts')
const EVALS = join(ROOT, 'fixtures/evals')

const hashOf = (path) => createHash('sha256').update(readFileSync(path, 'utf8')).digest('hex').slice(0, 12)

const prompts = existsSync(PROMPTS) ? readdirSync(PROMPTS).filter((f) => f.endsWith('.md')) : []
if (prompts.length === 0) {
  console.error('No prompts found. This check has nothing to verify, which is not the same as passing.')
  process.exit(2)
}

const recorded = (existsSync(EVALS) ? readdirSync(EVALS) : [])
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({ file: f, ...JSON.parse(readFileSync(join(EVALS, f), 'utf8')) }))

const stale = []
for (const prompt of prompts) {
  const hash = hashOf(join(PROMPTS, prompt))
  const runs = recorded.filter((r) => r.promptHash === hash)
  if (runs.length === 0) stale.push({ prompt, hash })
}

if (stale.length > 0) {
  console.error(`\n${stale.length} prompt(s) with no evaluation of their current text\n`)
  for (const s of stale) {
    console.error(`✗ src/llm/prompts/${s.prompt}`)
    console.error(`  hash        ${s.hash}`)
    console.error(`  recorded    ${recorded.map((r) => `${r.model}@${r.promptHash}`).join(', ') || 'nothing'}`)
    console.error(`  fix         npm run eval:agent-job, have agents answer it, npm run eval:agent-record, then commit fixtures/evals/`)
    console.error('')
  }
  process.exit(1)
}

for (const r of recorded) {
  // `agreed/measured` alone reads as perfect whenever everything measured
  // agreed, even if a third of the corpus never got an answer. The case count
  // is the part that says whether the score covers the corpus at all.
  const gap = r.measured < r.cases ? `  (${r.cases - r.measured} of ${r.cases} unmeasured)` : ''
  // Records from before `method` existed were all produced by `calibrate.mjs`,
  // so an absent method means the API. Printed on every line because an agent
  // score and an API score are the same model and not the same measurement.
  console.log(`${r.model}  ${r.corpus ?? 'messages'}  prompt ${r.promptHash}  agreed ${r.agreed}/${r.measured} of ${r.cases}${gap}  (${r.method ?? 'api'})`)
}
console.log(`✓ every prompt has a recorded evaluation of its current text.`)
