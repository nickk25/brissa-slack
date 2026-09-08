#!/usr/bin/env node
/**
 * Phase 01: did the translation actually say everything, or just decide to?
 *
 * `calibrate.mjs` scores the DECISION — translate or stay silent — against an
 * answer a person wrote by hand. It is deliberately blind to what comes back
 * once the model says yes; its own header says so. That blindness cost
 * something real: on `c-001`, the corpus's own canonical case, production made
 * the right decision and then returned five German lines with the fifth,
 * `Sorry, aber wir sollten alle an board haben`, untouched — sitting in German
 * inside an otherwise Spanish translation. The decision eval scored that case a
 * pass. Nothing measured the failure; a human noticed it in a screenshot. This
 * file exists so the next one like it is caught here instead of there.
 *
 * The primary signal is deterministic on purpose, not a model judging a model:
 * a model asked "is this translation any good" answers with the same fluent
 * confidence that produced the untranslated line in the first place, and a
 * judge that can be charmed by fluency is not a check on fluency. What actually
 * happened has a precise, checkable signature instead — a line of the source
 * survived into the output essentially unchanged — and that is exactly what
 * gets measured here: per source line, does it reappear in the translation,
 * verbatim or close enough to it that nothing was done to it.
 *
 * What this deliberately does NOT measure, and never claims to: whether the
 * translation reads naturally, whether idiom or tone survived, whether a
 * correctly *translated* line is simply wrong. Those need a reader, or a judge
 * model, and either belongs in a tool honestly labelled as such — not this one.
 * This answers a narrower question, "did the words make it across at all", and
 * that narrower question is exactly the one that went unmeasured and cost a
 * reader a sentence they could not read.
 *
 * Reports, does not block — same split the corpus README's two-layer table
 * describes: this is not deterministic enough, case to case, to gate a pull
 * request the way the decision layer does, and treating a noisy score as a
 * gate would turn "the model phrased something a little oddly" into a false
 * red as often as it turns "the model dropped a sentence" into a false green.
 * `--strict` exists for a human choosing to run it that way — never for CI.
 *
 *   node --experimental-strip-types tools/eval/quality.mjs
 *   node --experimental-strip-types tools/eval/quality.mjs --model claude-opus-5
 *   node --experimental-strip-types tools/eval/quality.mjs --corpus held-out --runs 5
 *   node --experimental-strip-types tools/eval/quality.mjs --strict
 *
 * Same methodology `calibrate.mjs` already established, because a second eval
 * inventing its own conventions is a second thing to learn: several runs per
 * case, because a single run is not a measurement; the prompt's hash carried
 * in the output, so a score can never be mistaken for one that scored a prompt
 * which has since changed; `--model` and `--corpus` to point it elsewhere.
 *
 * `createTranslator` is imported from `src/llm/decide.ts`, never reimplemented
 * — the whole point is to measure what production actually runs, not a
 * hand-rolled stand-in that could quietly drift from the real prompt or the
 * real request shape. That import is dynamic and lives only inside `main()`,
 * reached only when this file is invoked directly (see the guard at the very
 * bottom): importing a TypeScript module any other way would mean loading this
 * file at all — including just to read its exported functions — requires a
 * TypeScript compiler in the loop, which is exactly the dependency
 * `quality.test.mjs` is written to avoid. Same reasoning for
 * `src/core/ask.ts`'s `hasNothingToRead`, reused rather than re-stripped.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = process.cwd()
const CORPUS_DIR = join(ROOT, 'fixtures/corpus')
const PROMPT = join(ROOT, 'src/llm/prompts/decide.md')

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const flag = (name) => process.argv.includes(`--${name}`)

/* ---------------------------------------------------------------------------
 * "Already readable" — the difference between `c-001`'s `Hi all.` and its
 * `Sorry, aber wir sollten alle an board haben`.
 *
 * Both are short lines that can end up byte-for-byte in the output. One of
 * them belongs there: the reader reads English, so an English line staying
 * English is the translator correctly doing nothing, not the translator
 * failing to do something. The other is German surviving into a translation
 * for a reader never shown to read German — the actual bug this file exists to
 * catch. A check that only asks "does this source line appear in the output"
 * cannot tell those two apart; it would flag the greeting as loudly as the
 * failure, and the report would be too noisy to read let alone trust.
 *
 * The distinguishing test: strip punctuation, and see whether most of a
 * line's words are closed-class function words — articles, pronouns,
 * conjunctions, a handful of common greetings — belonging to a language the
 * reader reads. `Hi all.` is two words, both common English function/greeting
 * words: 100%. `Sorry, aber wir sollten alle an board haben` is mostly German
 * function words (`aber`, `wir`, `sollten`, `haben`) plus a couple of
 * English-shaped tokens (`sorry`, `an`, `board` are all real English words,
 * deliberately left out of the English list below for exactly this reason —
 * they are also loanwords or false friends in German) — nowhere near a
 * majority.
 *
 * HONESTY: this is not language identification. It leans on the fact that
 * function words differ sharply between unrelated languages even when content
 * words are borrowed freely between them, and it is wrong in both directions:
 *
 *   - A genuinely untranslated line built mostly from loanwords and short
 *     shared words could read as "already readable" when it is not. That is a
 *     false negative for this tool: a real failure goes unreported.
 *   - A legitimately-kept line with almost no function words at all — a
 *     two-word product name, a person's name on its own line — could read as
 *     "not readable" and get flagged as survived when it is fine. That is
 *     noise in the report, not a real failure.
 *
 * Both are why this reports rather than blocks, and why the per-case detail is
 * printed rather than only the total: a human reading five flagged lines can
 * tell in a second which of them is `board`-in-German and which is a product
 * name that was never going to translate.
 * ------------------------------------------------------------------------ */
const FUNCTION_WORDS = {
  en: new Set([
    'a', 'the', 'is', 'are', 'am', 'was', 'were', 'be', 'been', 'being',
    'i', 'you', 'he', 'she', 'it', 'we', 'they', 'this', 'that', 'these', 'those',
    'and', 'or', 'but', 'not', 'no', 'yes', 'hi', 'hello', 'hey', 'all',
    'of', 'to', 'in', 'on', 'for', 'with', 'at', 'by', 'from', 'as', 'so',
    'do', 'does', 'did', 'have', 'has', 'had', 'will', 'would', 'can', 'could', 'should',
    'thanks', 'thank', 'please', 'yeah', 'yep', 'ok', 'okay',
  ]),
  es: new Set([
    'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del',
    'y', 'o', 'pero', 'no', 'si', 'es', 'son', 'era', 'fue', 'yo', 'tu',
    'ella', 'nosotros', 'ellos', 'este', 'esta', 'estos', 'estas',
    'que', 'en', 'a', 'por', 'para', 'con', 'como', 'hola', 'gracias',
    'todos', 'todas', 'favor',
  ]),
}

/** Lowercase words, letters and digits only — punctuation is not a token. */
function words(line) {
  return line.toLowerCase().match(/[\p{Letter}\p{Number}]+/gu) ?? []
}

/**
 * True when at least half of a line's words are closed-class words of a
 * language the reader reads. See the block comment above for what this can
 * and cannot see — it is a heuristic, and known to be wrong in both directions.
 */
export function isAlreadyReadable(line, reads) {
  const tokens = words(line)
  if (tokens.length === 0) return false
  for (const code of reads) {
    const known = FUNCTION_WORDS[code]
    if (!known) continue // no list for this language: cannot vouch for it, so don't
    const hits = tokens.filter((t) => known.has(t)).length
    if (hits / tokens.length >= 0.5) return true
  }
  return false
}

/* ---------------------------------------------------------------------------
 * Verbatim, or close enough to it that the model plainly did not touch the
 * line — a normalised Levenshtein ratio rather than exact string equality, so
 * a translator that only reflows whitespace or fixes a stray space doesn't get
 * credit for "translating" a line it left untouched in every way that matters.
 * ------------------------------------------------------------------------ */
function normalise(line) {
  return line.toLowerCase().replace(/\s+/g, ' ').trim()
}

function levenshtein(a, b) {
  if (a === b) return 0
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const row = [i]
    for (let j = 1; j <= n; j++) {
      row[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], row[j - 1])
    }
    prev = row
  }
  return prev[n]
}

/** 1 for identical strings, 0 for maximally different ones of that length. */
export function similarity(a, b) {
  const longest = Math.max(a.length, b.length)
  if (longest === 0) return 1
  return 1 - levenshtein(a, b) / longest
}

/** Below this, a match is coincidence rather than evidence a line survived. */
const SIMILARITY_THRESHOLD = 0.85

/** Shorter than this (normalised), a match is far too cheap to mean anything. */
const MIN_LINE_LENGTH = 3

/**
 * The lines of `source` that reappear, essentially unchanged, in `translated`.
 *
 * `hasNothingToRead` is a required parameter rather than an import: this
 * module has no static dependency on any TypeScript file (see the file
 * header), so the real one — `src/core/ask.ts` — is handed in by the caller.
 * `main()` hands in the genuine function; `quality.test.mjs` hands in a small
 * stand-in, which keeps this file, and its tests, loadable without a
 * TypeScript compiler in the loop.
 */
export function findSurvivedLines({ source, translated, reads, hasNothingToRead }) {
  const translatedLines = translated.split('\n').map(normalise)
  const survived = []
  for (const raw of source.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (hasNothingToRead(line)) continue // emoji-only, code, a bare url, an @mention: nothing to translate
    if (isAlreadyReadable(line, reads)) continue // already in a language the reader reads
    const normalised = normalise(line)
    if (normalised.length < MIN_LINE_LENGTH) continue
    const match = translatedLines.find((t) => similarity(normalised, t) >= SIMILARITY_THRESHOLD)
    if (match !== undefined) survived.push({ line, matchedAgainst: match })
  }
  return survived
}

/**
 * One case, asked `runs` times.
 *
 * `translator` is anything shaped like `src/core/translator.ts`'s `Translator`
 * port — `{ translate(request): Promise<TranslationResult> }` — never imported
 * as a type here, only relied on structurally, so a fake object satisfies it
 * with no TypeScript in sight. `main()` hands in the real one; the tests hand
 * in whatever a fixture needs.
 *
 * A run that comes back `silent` or `failed` is not this tool's problem to
 * report: `calibrate.mjs` already measures whether the *decision* was right,
 * and a case in this corpus scored `expected: "translate"` landing here as
 * anything but `translated` is a decision regression, not a quality one.
 * Counting it as "clean" would hide it, so it is kept, bucketed by kind, and
 * left out of `measured` rather than silently improving the score.
 */
export async function runCase(c, translator, reads, runs, hasNothingToRead) {
  const perRun = []
  for (let i = 0; i < runs; i++) {
    const result = await translator.translate({ text: c.text, reads })
    if (result.kind !== 'translated') {
      perRun.push({ kind: result.kind, detail: result.kind === 'failed' ? result.detail : undefined })
      continue
    }
    const survived = findSurvivedLines({ source: c.text, translated: result.translation.text, reads, hasNothingToRead })
    perRun.push({ kind: 'translated', survived })
  }
  return perRun
}

/* ---------------------------------------------------------------------------
 * Running it for real — everything below this line reaches for the
 * TypeScript modules this tool depends on, and none of it runs unless this
 * file is invoked directly (see the guard at the bottom).
 * ------------------------------------------------------------------------ */

async function main() {
  const model = arg('model', 'claude-sonnet-5')
  // Which set. Same rule as `calibrate.mjs`: `messages` may be tuned against;
  // `held-out` may be run but never read case-by-case to change anything.
  const corpusName = arg('corpus', 'messages')
  const runs = Number(arg('runs', '3'))
  const strict = flag('strict')
  const out = arg('out', `fixtures/evals/quality-${corpusName === 'messages' ? model : `${corpusName}-${model}`}.json`)

  const corpus = JSON.parse(readFileSync(join(CORPUS_DIR, `${corpusName}.json`), 'utf8'))
  const promptRaw = readFileSync(PROMPT, 'utf8')
  const promptHash = createHash('sha256').update(promptRaw).digest('hex').slice(0, 12)

  const { createTranslator } = await import(join(ROOT, 'src/llm/decide.ts'))
  const { hasNothingToRead } = await import(join(ROOT, 'src/core/ask.ts'))
  const { default: Anthropic } = await import('@anthropic-ai/sdk')

  const client = new Anthropic()
  const translator = createTranslator(client.messages, { model, promptPath: PROMPT })

  // Only cases the corpus itself says should have been translated — there is
  // no output to check the completeness of otherwise.
  const cases = corpus.cases.filter((c) => c.expected === 'translate')
  const results = []

  for (const c of cases) {
    const perRun = await runCase(c, translator, corpus.reads, runs, hasNothingToRead)
    const measured = perRun.filter((r) => r.kind === 'translated')
    const clean = measured.length > 0 && measured.every((r) => r.survived.length === 0)
    const survivedLines = [...new Set(measured.flatMap((r) => r.survived.map((s) => s.line)))]
    results.push({ id: c.id, runs: perRun, measured: measured.length, clean, survivedLines })
    process.stdout.write(measured.length === 0 ? 'E' : clean ? '.' : 'X')
  }
  process.stdout.write('\n')

  const measuredCases = results.filter((r) => r.measured > 0)
  const dirty = measuredCases.filter((r) => !r.clean)
  const unmeasured = results.filter((r) => r.measured === 0)

  const report = {
    model,
    corpus: corpusName,
    promptHash,
    ranAt: new Date().toISOString(),
    runs,
    casesConsidered: cases.length,
    measured: measuredCases.length,
    clean: measuredCases.filter((r) => r.clean).length,
    survivedLines: dirty.map((r) => ({ id: r.id, lines: r.survivedLines })),
    unmeasured: unmeasured.map((r) => r.id),
    results,
  }

  mkdirSync(dirname(join(ROOT, out)), { recursive: true })
  writeFileSync(join(ROOT, out), `${JSON.stringify(report, null, 2)}\n`)

  console.log(`${model}  ${corpusName}  prompt ${promptHash}  ${runs} runs per case`)
  console.log(`  cases considered  ${report.casesConsidered} (expected: translate)`)
  console.log(`  clean every run   ${report.clean}/${report.measured}`)
  console.log(`  survived lines    ${dirty.map((r) => r.id).join(', ') || 'none'}`)
  if (unmeasured.length) console.log(`  could not measure ${unmeasured.length}: ${unmeasured.map((r) => r.id).join(', ')}`)
  console.log(`  written to        ${out}`)

  for (const r of dirty) {
    console.log(`\n✗ ${r.id}`)
    for (const line of r.survivedLines) console.log(`    survived: ${line}`)
  }

  // Same non-judgement `calibrate.mjs` makes, except when a human asks for
  // one: this run exists to produce a number, and exiting non-zero by default
  // would make a report look like a broken tool. `--strict` is that human
  // choosing otherwise, on their own machine — it is never wired into a gate.
  if (strict && dirty.length > 0) {
    console.error(`\n--strict: ${dirty.length} case(s) had a source line survive into the translation`)
    process.exit(1)
  }
}

// Reached only when this file is run directly (`node tools/eval/quality.mjs`
// or `npm run eval:quality`), never when `quality.test.mjs` imports its pure
// functions — see the file header for why that distinction is load-bearing.
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) await main()
