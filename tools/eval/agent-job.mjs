#!/usr/bin/env node
/**
 * The corpus, prepared for agents to answer — and stripped of every hint.
 *
 *   npm run eval:agent-job -- --corpus messages
 *
 * Evaluations run through agents on the same model rather than through the API,
 * so that API spend is only ever real usage (see `tools/spend-guard.mjs`). This
 * writes what those agents are given: the system prompt exactly as production
 * builds it, and the cases.
 *
 * **Only `id` and `text` leave this file.** A corpus case also carries
 * `expected`, `languages`, `startsIn`, `categories` and `note`, and every one of
 * them gives the answer away — `languages: ['de']` already says there is German
 * to translate. An agent that can see them is not being evaluated; it is being
 * asked to read. `agent-job.test.mjs` pins that nothing else gets through.
 */

import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPrompt, loadCorpus } from './scoring.mjs'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

/** What an agent may see of a corpus. Exported so the stripping can be tested. */
export function jobFor(corpusName, corpus, prompt) {
  return {
    corpus: corpusName,
    promptHash: prompt.hash,
    system: prompt.text,
    instructions: [
      'You are standing in for one API call, many times over. The `system` field is a system prompt; each case is a single user message sent under it.',
      'Answer every case independently, as if it were the only message you had ever been sent under that prompt. Do not let one case inform another.',
      'Follow the prompt exactly, including its rules about staying silent. Do not be more helpful than it asks.',
      'For each case give only whether the prompt says to translate: true or false.',
    ],
    cases: corpus.cases.map((c) => ({ id: c.id, text: c.text })),
  }
}

function main() {
  const corpusName = arg('corpus', 'messages')
  const corpus = loadCorpus(corpusName)
  const prompt = buildPrompt(corpus.reads, corpus.reads[0])
  const out = arg('out', join(tmpdir(), `brissa-eval-${corpusName}-${prompt.hash}.job.json`))

  writeFileSync(out, `${JSON.stringify(jobFor(corpusName, corpus, prompt), null, 2)}\n`)
  console.log(`${corpusName}  prompt ${prompt.hash}  ${corpus.cases.length} cases`)
  console.log(`  job written to ${out}`)
  console.log('  each agent writes {"answers":[{"id":"c-001","translate":true}, ...]} to its own file')
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main()
