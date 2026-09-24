#!/usr/bin/env node
/**
 * Phase 00: does the model make the right decision on real messages?
 *
 *   calibrate --model claude-haiku-4-5
 *   calibrate --model claude-opus-5 --out fixtures/evals/reference.json
 *
 * This scores the **decision** only — translate or stay silent — against answers
 * a person wrote by hand in the corpus. Deliberately not translation quality:
 * that is not deterministic, cannot gate a pull request, and is measured
 * separately.
 *
 * The point of running it on two models is to turn "Haiku is enough" from a
 * belief into a number. A stronger model is the reference for what the corpus
 * *should* yield; the cheap one either matches it or does not.
 *
 * Every run records the prompt's hash alongside its score, so a result cannot be
 * quietly reused for a prompt it never saw.
 *
 * Each case is asked several times, because a model is not a function. The same
 * prompt scored 26/28 and then 27/28 on two consecutive runs, and treating either
 * number as the answer would have made noise look like the effect of a change.
 * What is reported is the count of cases the model gets right *every* time, plus
 * the cases whose answer moved — a flaky case is neither a pass nor a failure and
 * saying so is the only honest option.
 */

import Anthropic from '@anthropic-ai/sdk'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { requireSpendApproval } from '../spend-guard.mjs'
import { buildPrompt, loadCorpus, score, summarise } from './scoring.mjs'

const ROOT = process.cwd()

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

/**
 * One decision from the model.
 *
 * Structured output rather than parsing prose: the decision is a boolean and a
 * boolean parsed out of a sentence is a boolean that will one day be wrong.
 */
async function decide(client, model, system, message, attempts = 4) {
  // A 529 is the service saying "not now", not "no". Treating it as lost data
  // cost six of twenty-eight cases on one run and would cost a reader their
  // message in production — silently, which is the worst way to lose one.
  for (let attempt = 1; ; attempt++) {
    try {
      return await once(client, model, system, message)
    } catch (err) {
      const transient = err?.status === 529 || err?.status === 429 || (err?.status ?? 0) >= 500
      if (!transient || attempt >= attempts) throw err
      await new Promise((r) => setTimeout(r, 2 ** attempt * 500))
    }
  }
}

async function once(client, model, system, message) {
  const response = await client.messages.create({
    model,
    max_tokens: 2048,
    system,
    messages: [{ role: 'user', content: message }],
    output_config: {
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
    },
  })
  const block = response.content.find((c) => c.type === 'text')
  return JSON.parse(block.text)
}

async function main() {
  // Every call below is billed. The default route for an evaluation is agents
  // on the same model (`npm run eval:agent-job`), and this one runs only when a
  // paid measurement of the real call path has been approved for a reason.
  requireSpendApproval('calibrate')

  const model = arg('model', 'claude-sonnet-5')
  // Which set. `messages` is the one a prompt may be tuned against; `held-out`
  // is the one that only means anything because nobody looked at it while
  // writing the prompt. Running it is allowed; consulting its failures to decide
  // what the prompt should say is what spends it.
  const corpusName = arg('corpus', 'messages')
  const runs = Number(arg('runs', '3'))
  const out = arg('out', `fixtures/evals/${corpusName === 'messages' ? model : `${corpusName}-${model}`}.json`)
  const corpus = loadCorpus(corpusName)
  const { text: system, hash: promptHash } = buildPrompt(corpus.reads, corpus.reads[0])

  const client = new Anthropic()
  const perCase = new Map()

  for (const c of corpus.cases) {
    const answers = []
    const errors = []
    for (let i = 0; i < runs; i++) {
      try {
        const answer = await decide(client, model, system, c.text)
        answers.push(answer.translate ? 'translate' : 'ignore')
      } catch (err) {
        // Recorded, never swallowed: an attempt that could not be measured must
        // not silently count as agreement.
        errors.push(String(err?.message ?? err))
      }
    }
    perCase.set(c.id, { answers, errors })
    const distinct = [...new Set(answers)]
    const agreed = distinct.length === 1 && answers.length === runs && distinct[0] === c.expected
    process.stdout.write(agreed ? '.' : errors.length ? 'E' : distinct.length === 1 ? 'x' : '~')
  }
  process.stdout.write('\n')

  const report = {
    model,
    corpus: corpusName,
    promptHash,
    // The real call path: this prompt as the system prompt, constrained to the
    // schema production uses. Told apart from `agent` on purpose — the two are
    // the same model and not the same measurement.
    method: 'api',
    ranAt: new Date().toISOString(),
    ...score(corpus, perCase, runs),
  }

  mkdirSync(dirname(join(ROOT, out)), { recursive: true })
  writeFileSync(join(ROOT, out), `${JSON.stringify(report, null, 2)}\n`)
  console.log(summarise(report, out))

  // Disagreement is the finding, not a failure: this run exists to produce a
  // number, and exiting non-zero would make it look like a broken tool.
}

main()
