#!/usr/bin/env node
/**
 * What the agents answered, scored the way the API run is scored.
 *
 *   npm run eval:agent-record -- --job <job.json> --model claude-sonnet-5 run1.json run2.json run3.json
 *
 * One answer file per run, one run per agent, so the runs are independent draws
 * in the way `calibrate.mjs`'s repeated calls are. Scored by `scoring.mjs` — the
 * same function the API path uses — and recorded with `method: 'agent'`.
 *
 * **What this measures, and what it does not.** The same model, answering the
 * same prompt. Not the same call: in production `decide.md` *is* the system
 * prompt and the output is held to a schema by constrained decoding, while an
 * agent reads the prompt as content and writes its JSON by hand, carrying its
 * own instructions and tools besides. For whether the prompt translates or
 * stays silent that difference is small; at a boundary it may not be. That is
 * why `method` is recorded, why it is printed next to every score, and why
 * `src/llm/CLAUDE.md` names the cases where a paid run is worth recommending.
 *
 * Refused outright when the prompt has changed since the job was written: an
 * answer to yesterday's prompt recorded under today's hash would be exactly the
 * unrun eval passing for a run one that the hash exists to prevent.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { buildPrompt, loadCorpus, score, summarise } from './scoring.mjs'

const ROOT = process.cwd()

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

/**
 * Answers per case across runs, with every gap named rather than skipped.
 * Exported so the bookkeeping can be tested without files.
 */
export function collect(job, runFiles) {
  const known = new Set(job.cases.map((c) => c.id))
  const perCase = new Map(job.cases.map((c) => [c.id, { answers: [], errors: [] }]))

  runFiles.forEach((run, index) => {
    const seen = new Set()
    for (const a of run.answers ?? []) {
      if (!known.has(a.id)) throw new Error(`run ${index + 1} answered ${a.id}, which is not in this job`)
      // Answered, even if badly: marked seen so the same failure is not also
      // reported as "no answer". One run, one error, stated once.
      seen.add(a.id)
      if (typeof a.translate !== 'boolean') {
        perCase.get(a.id).errors.push(`run ${index + 1}: translate was ${JSON.stringify(a.translate)}, not a boolean`)
        continue
      }
      perCase.get(a.id).answers.push(a.translate ? 'translate' : 'ignore')
    }
    // A case a run skipped is a case that run did not measure. Never agreement.
    for (const id of known) if (!seen.has(id)) perCase.get(id).errors.push(`run ${index + 1}: no answer`)
  })

  return perCase
}

function main() {
  const jobPath = arg('job')
  const model = arg('model', 'claude-sonnet-5')
  if (!jobPath) {
    console.error('--job is required: the file `eval:agent-job` wrote, so the answers can be tied to the prompt they answered.')
    process.exit(2)
  }

  const job = JSON.parse(readFileSync(jobPath, 'utf8'))
  const corpus = loadCorpus(job.corpus)
  const current = buildPrompt(corpus.reads, corpus.reads[0])
  if (job.promptHash !== current.hash) {
    console.error(`The prompt changed after this job was written (job ${job.promptHash}, now ${current.hash}).`)
    console.error('Recording these answers would pass an old prompt off as the current one. Write a new job and run it again.')
    process.exit(1)
  }

  const flagValues = new Set(['--job', '--model', '--out'].map((f) => process.argv[process.argv.indexOf(f) + 1]))
  const files = process.argv.slice(2).filter((a) => !a.startsWith('--') && !flagValues.has(a))
  if (files.length === 0) {
    console.error('No answer files given: one per run, one run per agent.')
    process.exit(2)
  }

  const perCase = collect(job, files.map((f) => JSON.parse(readFileSync(f, 'utf8'))))
  const name = job.corpus === 'messages' ? model : `${job.corpus}-${model}`
  const out = arg('out', `fixtures/evals/agent-${name}.json`)

  const report = {
    model,
    corpus: job.corpus,
    promptHash: job.promptHash,
    method: 'agent',
    ranAt: new Date().toISOString(),
    ...score(corpus, perCase, files.length),
  }

  mkdirSync(dirname(join(ROOT, out)), { recursive: true })
  writeFileSync(join(ROOT, out), `${JSON.stringify(report, null, 2)}\n`)
  console.log(summarise(report, out))
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main()
