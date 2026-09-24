/**
 * How an evaluation is scored, whoever produced the answers.
 *
 * Shared on purpose. There are two ways to get a model's answers to the corpus
 * now — the API, through `calibrate.mjs`, and agents on the same model, through
 * `agent-record.mjs` — and the moment they scored differently, a difference in
 * the number would stop meaning a difference in the model. One function, so the
 * only thing that can differ between two reports is how the answers were
 * obtained, and that is recorded as `method`.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
export const CORPUS_DIR = join(ROOT, 'fixtures/corpus')
export const PROMPT = join(ROOT, 'src/llm/prompts/decide.md')

export const LANGUAGE_NAMES = { es: 'Spanish', en: 'English', de: 'German' }

/** The prompt with the reader's languages filled in, and the hash of its raw text. */
export function buildPrompt(reads, target, path = PROMPT) {
  const raw = readFileSync(path, 'utf8')
  const text = raw
    .replaceAll('{{READS}}', reads.map((l) => LANGUAGE_NAMES[l] ?? l).join(' and '))
    .replaceAll('{{TARGET}}', LANGUAGE_NAMES[target] ?? target)
  return { text, hash: createHash('sha256').update(raw).digest('hex').slice(0, 12) }
}

export function loadCorpus(name) {
  return JSON.parse(readFileSync(join(CORPUS_DIR, `${name}.json`), 'utf8'))
}

/**
 * The report, from the answers each case received across every run.
 *
 * `perCase` maps a case id to `{ answers, errors }`, where each answer is
 * `'translate'` or `'ignore'`. A case is agreed only when every run answered
 * and every answer matched — right every time, not right on average.
 */
export function score(corpus, perCase, runs) {
  const results = corpus.cases.map((c) => {
    const { answers = [], errors = [] } = perCase.get(c.id) ?? {}
    const distinct = [...new Set(answers)]
    const stable = distinct.length === 1
    return {
      id: c.id,
      expected: c.expected,
      answers,
      stable,
      agreed: stable && answers.length === runs && distinct[0] === c.expected,
      errors,
      categories: c.categories,
    }
  })

  const measured = results.filter((r) => r.answers.length === runs)
  const disagreed = measured.filter((r) => !r.agreed)
  return {
    runs,
    cases: corpus.cases.length,
    measured: measured.length,
    agreed: measured.filter((r) => r.agreed).length,
    flaky: measured.filter((r) => !r.stable).map((r) => ({ id: r.id, answers: r.answers })),
    // Kept apart because they cost different things: a false silence loses the
    // reader a message, a false translation is noise in a shared channel.
    missedTranslations: disagreed.filter((r) => r.stable && r.expected === 'translate').map((r) => r.id),
    needlessTranslations: disagreed.filter((r) => r.stable && r.expected === 'ignore').map((r) => r.id),
    errors: results.filter((r) => r.errors.length).map((r) => ({ id: r.id, errors: r.errors })),
    results,
  }
}

/** The lines a person reads, identical whichever method produced the report. */
export function summarise(report, out) {
  const lines = [
    `${report.model}  ${report.corpus}  prompt ${report.promptHash}  ${report.runs} runs per case  (${report.method})`,
    `  agreed every time ${report.agreed}/${report.measured}`,
    `  flaky             ${report.flaky.map((f) => f.id).join(', ') || 'none'}`,
    `  missed            ${report.missedTranslations.join(', ') || 'none'}`,
    `  needless          ${report.needlessTranslations.join(', ') || 'none'}`,
  ]
  if (report.errors.length) lines.push(`  could not measure ${report.errors.length}`)
  lines.push(`  written to        ${out}`)
  return lines.join('\n')
}
