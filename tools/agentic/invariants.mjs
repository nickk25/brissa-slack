#!/usr/bin/env node
/**
 * Invariants declared in contracts must map one-to-one onto tests that
 * actually ran and passed.
 *
 * A contract's Invariants section is prose, and prose is the part of a contract
 * that can lie. Anchoring each bullet to a test id is what stops it: the claim
 * stays in English, but its existence is checked against a real test.
 *
 *   contract   - A message already in the target language produces no plan. `test: INV-core-01`
 *   test file  test('INV-core-01 a message already in the target language produces no plan', () => { ... })
 *
 * The id lives in the test's own title, not in a nearby comment: it is a fixed
 * anchor immediately after the opening quote of a `test(`/`test.skip(`/`it(`…
 * call, not a search outward from the id, so a stray bracket or an unrelated
 * string literal elsewhere in the file has nothing to derail. The whole suite
 * runs once, and every id read off a title is checked against the state of
 * the test that carried it into that run.
 *
 * Both directions are enforced, and the second one is the one people forget:
 *
 *   documented with no test   a claim nobody checks. The whole point of the anchor.
 *   tested with no document   a rule the code enforces that no contract mentions,
 *                             so the next agent deletes it without knowing.
 *
 * A test whose title carries no id is simply outside this bookkeeping: it
 * still has to run and pass for `npm test` to succeed, but it makes no claim
 * about any invariant and is never mistaken for coverage of one. Most tests
 * carry an id; the rest are just tests.
 *
 * There is no "orphan id" bucket, and that is deliberate rather than an
 * oversight: an id lives inside a test's own title string, and a title string
 * has no position to occupy except inside a real `test(...)` call. So an id
 * is always either read off a real, running test (an occurrence) or it never
 * appears in a title at all, in which case it is just an invariant nobody
 * wrote a test for — already reported below as `missingTest`. A scheme that
 * instead anchored an id to a nearby comment (a `// @invariant` sitting
 * outside any `test(...)` call) would have no such guarantee and could
 * produce an id belonging to no test at all.
 *
 * This proves an invariant is *covered*, never that the test is any good. A test
 * that asserts nothing satisfies this happily. Mutation testing is what closes
 * that gap; this only closes the bookkeeping.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { discoverTestFiles, runSuite } from './probes/index.mjs'

const ROOT = process.cwd()
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next'])
// Deliberately anchored to `INV-`. Without the prefix this matched any
// capitalised-token-dash-word-dash-number, so an ordinary title like
// `HTTP-status-500 is mapped to a retry` was read as an undeclared invariant
// and broke the check for a repository that had done nothing wrong.
const ID = 'INV-[a-zA-Z0-9_]+-[0-9]+'

const c = process.stdout.isTTY
  ? { red: '\x1b[31m', green: '\x1b[32m', dim: '\x1b[2m', bold: '\x1b[1m', off: '\x1b[0m' }
  : { red: '', green: '', dim: '', bold: '', off: '' }

function walk(dir = ROOT, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry) || (entry.startsWith('.') && entry !== '.github')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

/** @returns {Map<string, {file: string, line: number}[]>} */
function collect(files, pattern) {
  const found = new Map()
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((text, i) => {
      for (const m of text.matchAll(pattern)) {
        const id = m[1]
        if (!found.has(id)) found.set(id, [])
        found.get(id).push({ file: relative(ROOT, file), line: i + 1 })
      }
    })
  }
  return found
}

// A test call whose title opens with an id: `test(`, `test.skip(`, `test.only(`,
// … followed by a quote, followed immediately by the id. "Immediately" is the
// whole point — it is the convention ("put the id at the front of the title")
// turned into an anchor a regex can find without understanding the rest of the
// file at all.
const TITLE_RE = new RegExp(`\\b(?:test|it)(?:\\.\\w+)?\\(\\s*(['"\`])(${ID})\\b`, 'g')

/**
 * Every id declared at the front of a test title in `file`, structurally —
 * used to attach a file and line number to an id before checking its
 * execution state (a test run's results carry no file attribution at all —
 * see `runSuite`).
 *
 * @returns {{ id: string, line: number }[]}
 */
function titleIdsIn(content) {
  const found = []
  for (const m of content.matchAll(TITLE_RE)) {
    found.push({ id: m[2], line: content.slice(0, m.index).split('\n').length })
  }
  return found
}

function main() {
  const json = process.argv.includes('--json')

  const files = walk()
  const contracts = files.filter((f) => f.endsWith('CLAUDE.md'))
  const testFiles = discoverTestFiles(ROOT) // same tree the real `npm test` covers — see probes/index.mjs

  const declared = collect(contracts, new RegExp(`\`test:\\s*(${ID})\``, 'g'))

  // Every id found at the front of a test title, structurally.
  const occurrences = new Map() // id -> [{file, line}]
  for (const file of testFiles) {
    const rel = relative(ROOT, file)
    const content = readFileSync(file, 'utf8')
    for (const { id, line } of titleIdsIn(content)) {
      if (!occurrences.has(id)) occurrences.set(id, [])
      occurrences.get(id).push({ file: rel, line })
    }
  }

  // Run every test file together, once, and check each id against the state
  // of the test whose title carried it. One process rather than one per file
  // is enough here — unlike a plain test name, an id is unique by construction
  // (a repeat is reported below as `duplicateTags`), so nothing depends on
  // knowing which file a passing test came from.
  const results = new Map() // id -> state
  const relFiles = testFiles.map((f) => relative(ROOT, f))
  const idAtStart = new RegExp(`^(${ID})\\b`)
  for (const { name, state } of runSuite(ROOT, relFiles).leaves) {
    const m = idAtStart.exec(name)
    if (m) results.set(m[1], state)
  }

  const stateOf = (id) => results.get(id) ?? 'not run'
  const isProven = (id) => stateOf(id) === 'pass'

  const tagged = new Set(occurrences.keys())
  const missingTest = [...declared.keys()].filter((id) => !tagged.has(id))
  // Both views of the world, reconciled. `occurrences` is what the source says;
  // `results` is what actually ran. An id the run reports but the scan never saw
  // means a title shape the regex cannot read — a template literal, a variable,
  // a helper — and without this it would fall out of both directions and be
  // reported nowhere at all.
  const seenInRun = new Set(results.keys())
  const unscanned = [...seenInRun].filter((id) => !tagged.has(id))
  const undocumented = [...new Set([...tagged, ...seenInRun])].filter((id) => !declared.has(id))
  const duplicated = [...declared.entries()].filter(([, at]) => at.length > 1)
  // Two tests carrying the same id means deleting either leaves the claim
  // looking covered, so neither is really load-bearing.
  const duplicateTags = [...occurrences.entries()].filter(([, at]) => at.length > 1)

  // Declared, tagged, but the test that carries the tag did not execute-and-pass.
  const unverified = [...occurrences.entries()]
    .filter(([id]) => declared.has(id))
    .filter(([id]) => !isProven(id))
    .map(([id, occs]) => ({ id, occurrences: occs.map((o) => ({ ...o, state: stateOf(id) })) }))

  const problems = missingTest.length + undocumented.length + duplicated.length + duplicateTags.length + unverified.length + unscanned.length

  if (json) {
    console.log(JSON.stringify({
      declared: declared.size,
      tagged: tagged.size,
      missingTest,
      undocumented,
      duplicated: duplicated.map(([id, at]) => ({ id, at })),
      duplicateTags: duplicateTags.map(([id, at]) => ({ id, at })),
      unscanned,
      unverified,
    }, null, 2))
    process.exit(problems ? 1 : 0)
  }

  if (!problems) {
    console.log(`${c.green}✓${c.off} ${declared.size} invariant${declared.size === 1 ? '' : 's'} declared, each with exactly one test.`)
    return
  }

  console.error(`\n${c.red}${c.bold}${problems} invariant problem${problems > 1 ? 's' : ''}${c.off}\n`)

  for (const id of missingTest) {
    const at = declared.get(id)[0]
    console.error(`${c.red}✗${c.off} ${c.bold}${id}${c.off} ${c.dim}declared but never tested${c.off}`)
    console.error(`  ${c.dim}declared at${c.off}  ${at.file}:${at.line}`)
    console.error(`  ${c.dim}fix${c.off}          write the test with \`${id}\` at the front of its title, or drop the claim from the contract`)
    console.error('')
  }
  for (const { id, occurrences: occs } of unverified) {
    console.error(`${c.red}✗${c.off} ${c.bold}${id}${c.off} ${c.dim}tagged, but its test did not run and pass${c.off}`)
    for (const o of occs) {
      console.error(`  ${c.dim}tagged at${c.off}    ${o.file}:${o.line} ${c.dim}(state: ${o.state})${c.off}`)
    }
    console.error(`  ${c.dim}fix${c.off}          make the test run and pass, or drop the claim from the contract`)
    console.error('')
  }
  for (const id of undocumented) {
    const at = occurrences.get(id)[0]
    console.error(`${c.red}✗${c.off} ${c.bold}${id}${c.off} ${c.dim}tested but not in any contract${c.off}`)
    console.error(`  ${c.dim}tagged at${c.off}    ${at.file}:${at.line}`)
    console.error(`  ${c.dim}fix${c.off}          add the invariant to the module's contract; an unwritten rule gets deleted by the next agent`)
    console.error('')
  }
  for (const id of unscanned) {
    console.error(`${c.red}✗${c.off} ${c.bold}${id}${c.off} ${c.dim}ran, but no test title in the source declares it${c.off}`)
    console.error(`  ${c.dim}fix${c.off}          the title is built in a way the scanner cannot read — a template literal, a variable, a helper. Write the id as a plain literal at the front of the title.`)
    console.error('')
  }
  for (const [id, at] of duplicateTags) {
    console.error(`${c.red}✗${c.off} ${c.bold}${id}${c.off} ${c.dim}used as the title of more than one test${c.off}`)
    console.error(`  ${c.dim}at${c.off}           ${at.map((a) => `${a.file}:${a.line}`).join(', ')}`)
    console.error(`  ${c.dim}fix${c.off}          one claim, one test. Deleting either of these would leave the claim looking covered.`)
    console.error('')
  }
  for (const [id, at] of duplicated) {
    console.error(`${c.red}✗${c.off} ${c.bold}${id}${c.off} ${c.dim}declared in more than one place${c.off}`)
    console.error(`  ${c.dim}at${c.off}           ${at.map((a) => `${a.file}:${a.line}`).join(', ')}`)
    console.error(`  ${c.dim}fix${c.off}          one invariant, one contract. Give the second one its own id.`)
    console.error('')
  }

  process.exit(1)
}

main()
