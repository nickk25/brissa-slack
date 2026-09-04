#!/usr/bin/env node
/**
 * Does a prompt contain the answers?
 *
 * The corpus sits behind a human label because whoever can edit the expected
 * answer can never be wrong. That guards one side of the exam and left the other
 * wide open: nothing stopped anybody pasting the failing cases into the prompt
 * instead, and the score jumped from 26/28 to a meaningless 28/28 the first time
 * somebody tried it. It was me, within minutes of writing the rule.
 *
 * So: a prompt may not quote the corpus. It may describe any pattern it likes —
 * that the grammar decides the language, that a borrowed noun does not make a
 * sentence English — but the moment it names a case, that case stops measuring
 * anything.
 *
 * The check is a substring scan, deliberately crude. It cannot catch a case
 * paraphrased closely enough to teach the answer without repeating it, and
 * nothing mechanical can. What it does catch is the easy, tempting version, and
 * a held-out split is what would close the rest.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const PROMPTS = join(ROOT, 'src/llm/prompts')
const CORPUS_DIR = join(ROOT, 'fixtures/corpus')

/**
 * Long enough that a shared phrase is quotation rather than coincidence, short
 * enough to catch a fragment of one. `Also 500 aerzte` is 15 characters, and it
 * is exactly the case this exists for, so the window has to sit under it.
 */
const WINDOW = 14

/** Case, punctuation and whitespace are noise for this comparison. */
const normalise = (s) =>
  s
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim()

/** Every distinct window-length run of characters in a string. */
function windows(text) {
  const out = new Set()
  for (let i = 0; i + WINDOW <= text.length; i++) out.add(text.slice(i, i + WINDOW))
  return out
}

const corpusFiles = existsSync(CORPUS_DIR) ? readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.json')) : []
if (corpusFiles.length === 0) {
  console.error('No corpus found. This check has nothing to compare against, which is not the same as passing.')
  process.exit(2)
}
if (!existsSync(PROMPTS)) {
  console.error('No prompts found. Nothing to check.')
  process.exit(2)
}

const cases = corpusFiles.flatMap((f) => JSON.parse(readFileSync(join(CORPUS_DIR, f), 'utf8')).cases.map((c) => ({ ...c, from: f })))
const prompts = readdirSync(PROMPTS).filter((f) => f.endsWith('.md'))

const found = []
for (const file of prompts) {
  const prompt = normalise(readFileSync(join(PROMPTS, file), 'utf8'))
  for (const c of cases) {
    const text = normalise(c.text)
    if (text.length < WINDOW) continue // too short to quote distinctively
    const quoted = [...windows(text)].filter((w) => prompt.includes(w))
    if (quoted.length > 0) found.push({ file, id: `${c.from}:${c.id}`, sample: quoted[0] })
  }
}

if (found.length > 0) {
  console.error(`\n${found.length} corpus case(s) quoted in a prompt\n`)
  for (const f of found) {
    console.error(`✗ src/llm/prompts/${f.file} contains ${f.id}`)
    console.error(`  matched     "…${f.sample}…"`)
    console.error(`  why         a case whose answer is written into the prompt measures nothing`)
    console.error(`  fix         describe the pattern instead of naming the case, or invent an example`)
    console.error('')
  }
  process.exit(1)
}

console.log(`✓ no prompt quotes the corpus (${prompts.length} prompt(s), ${cases.length} case(s) across ${corpusFiles.length} set(s)).`)
