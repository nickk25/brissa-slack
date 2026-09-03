/**
 * Probes: the facts a snapshot is made of.
 *
 * Every value here is measured, never narrated. That is the whole discipline of
 * the state page — an agent asked to summarise its own work writes something
 * optimistic, so no agent writes any of this.
 *
 * A probe is `{ name, measure(ctx) }` returning plain JSON. Add a project's own
 * as another file in this folder. Keep each value comparable across runs: the
 * timeline is built by diffing two snapshots, so a field that churns for no
 * reason becomes an entry that means nothing.
 *
 * Deliberately absent, and worth saying out loud: line coverage, test count,
 * commits per week, lines added. Agents inflate all four without moving quality,
 * and a number that only ever goes up stops being read.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.agentic'])
const ROOT = process.cwd()

// The one definition of "the suite". `package.json`'s test script points Node
// at this same pattern, quoted so Node expands it rather than sh — sh collapses
// `**` to `*` and would reach only one level down, which would let a claim be
// proven by a test the suite never runs.
const TEST_DIR = 'tools/agentic'
const TEST_FILE_RE = /\.test\.mjs$/

// Node's own test runner sets NODE_TEST_CONTEXT on itself; a child `node
// --test` process that inherits it assumes it is being driven by a parent
// test run over IPC rather than asked to report over stdio, and produces no
// usable TAP text at all. Every probe here spawns test runs as plain,
// standalone subprocesses — regardless of whether the process running this
// file is itself under `node --test` (our own test suite does exactly that:
// it runs invariants.mjs, which runs these probes, from inside `node --test`)
// — so that variable must never be passed through.
const { NODE_TEST_CONTEXT: _dropNodeTestContext, ...CLEAN_ENV } = process.env

function run(cmd, args, opts = {}) {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: 'pipe', env: CLEAN_ENV, ...opts }) }
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry) || entry.startsWith('.')) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

/** Every `*.test.mjs` file inside the directory the real test run covers. */
export function discoverTestFiles(root = ROOT) {
  try {
    return walk(join(root, TEST_DIR)).filter((f) => TEST_FILE_RE.test(f))
  } catch {
    return []
  }
}

/**
 * Parse Node's TAP output into leaf tests only, each with its true state.
 *
 * Node nests a `describe()` block as a subtest of its own: its close line
 * looks exactly like a test result ("ok N - <suite name>") and is only
 * distinguishable by a `type: 'suite'` field in the diagnostic YAML that
 * follows it — a field only Node's own TAP output shows for suites, and
 * that arrives *after* the suite's children (Node closes a suite once every
 * child has run), which is why we need a two-pass-in-one-loop shape: track
 * open contexts from the "# Subtest: <name>" comment (which precedes both
 * suites and tests) and only decide "test vs suite" once we reach the
 * matching result line's diagnostic block.
 *
 * SKIP and TODO are carried as their own states. Node reports both as a
 * trailing TAP directive on the result line ("ok N - name # SKIP reason",
 * "not ok N - name # TODO"); left unhandled, a naive parser both records a
 * skipped test as a pass and leaves the directive text stuck to the name.
 */
export function parseTap(tapText) {
  const lines = tapText.split('\n')
  const stack = [] // {indent, name} — open "# Subtest:" contexts, outer to inner
  const leaves = []

  const SUBTEST_RE = /^(\s*)# Subtest: (.+)$/
  const RESULT_RE = /^(\s*)(not ok|ok)\s+\d+\s+-\s+(.+?)\s*$/
  const SUITE_TYPE_RE = /^\s*type:\s*'suite'\s*$/
  const BLOCK_END_RE = /^\s*\.\.\.\s*$/
  const DIRECTIVE_RE = /^(.*?)\s*(?<!\\)#\s*(SKIP|TODO)\b.*$/i

  for (let i = 0; i < lines.length; i++) {
    const sm = SUBTEST_RE.exec(lines[i])
    if (sm) {
      stack.push({ indent: sm[1].length, name: sm[2] })
      continue
    }

    const rm = RESULT_RE.exec(lines[i])
    if (!rm) continue
    const [, indent, okness, rawName] = rm

    // Look ahead into this result's own diagnostic block (up to the next
    // "..." close, or bail if another result/subtest line shows up first,
    // meaning there was no block at all) to see whether it is a suite.
    let isSuite = false
    for (let j = i + 1; j < lines.length; j++) {
      if (BLOCK_END_RE.test(lines[j])) break
      if (RESULT_RE.test(lines[j]) || SUBTEST_RE.test(lines[j])) break
      if (SUITE_TYPE_RE.test(lines[j])) {
        isSuite = true
        break
      }
    }

    // This result line closes the context opened by the "# Subtest:" line
    // at the same indentation — that is the name (and possible suite-hood)
    // this line is reporting on.
    if (stack.length && stack[stack.length - 1].indent === indent.length) stack.pop()

    if (isSuite) continue // a describe() close, not a test

    let name = rawName
    let state = okness === 'ok' ? 'pass' : 'fail'
    const dm = DIRECTIVE_RE.exec(rawName)
    if (dm) {
      name = dm[1]
      state = dm[2].toLowerCase() // 'skip' | 'todo' — never counted as 'pass'
    }

    const qualifiedName = [...stack.map((s) => s.name), name].join(' > ')
    leaves.push({ name, qualifiedName, state })
  }

  return leaves
}

// A second, minimal test reporter, riding alongside the `tap` one in the same
// run, whose only job is to say which file each leaf test came from — the one
// thing TAP text never carries (see `runSuite`). Passed to `node --test` as a
// `data:` module specifier so no extra file is needed. Written as a single
// line with no `#`: a data: URL's data is percent-decoded and its content
// ends at the first `#`, so either would corrupt or truncate the source.
const FILE_REPORTER =
  "data:text/javascript,export default async function*(source){for await(const e of source){" +
  "if(e.type!=='test:pass'&&e.type!=='test:fail')continue;" +
  "const d=e.data;if(d.details&&d.details.type==='suite')continue;" +
  "yield JSON.stringify({file:d.file})+String.fromCharCode(10)}}"

/**
 * Run every test file once, in a single subprocess, and return each leaf
 * test's TAP result together with the file it came from.
 *
 * `invariants.mjs` only needs to know, per invariant id, whether the test
 * whose title carries that id passed — it never needs the file. The `tests`
 * probe needs exactly the file, to key results so two files with an
 * identically named test do not collide. Both are answered by one run: Node
 * hands every attached reporter the same ordered stream of test events, so
 * the `tap` reporter (parsed by {@link parseTap} above) and `FILE_REPORTER`
 * (which emits one line per non-suite leaf, in that same order) produce two
 * lists that line up position-for-position — the Nth leaf in one is the Nth
 * leaf in the other. Zipping them attaches a file to each TAP leaf without
 * having to decide what "the same test" means across two differently shaped
 * outputs.
 *
 * Passing no files would let `node --test` fall back to discovering the
 * whole cwd on its own, which no caller here wants, so an empty list
 * short-circuits to an empty result instead.
 */
export function runSuite(root, relFiles) {
  if (!relFiles.length) return { leaves: [] }
  // A failing suite emits a diagnostic block per failure, so output grows
  // fastest exactly when it matters most; maxBuffer covers both streams.
  const r = spawnSync('node', [
    '--test', '--test-reporter=tap', '--test-reporter-destination=stdout',
    '--test-reporter', FILE_REPORTER, '--test-reporter-destination=stderr',
    ...relFiles,
  ], { cwd: root, env: CLEAN_ENV, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

  const files = (r.stderr ?? '').split('\n').filter(Boolean).map((line) => {
    try {
      return relative(root, JSON.parse(line).file)
    } catch {
      return null
    }
  })

  return { leaves: parseTap(r.stdout ?? '').map((leaf, i) => ({ ...leaf, file: files[i] ?? null })) }
}

/**
 * Which invariants exist and which of them a test actually covers.
 *
 * The interesting number is not how many are covered — it is which ones are not.
 * A contract that claims more than it proves is the failure this whole scaffold
 * exists to make visible.
 */
export const invariants = {
  name: 'invariants',
  measure: () => {
    const r = run('node', ['tools/agentic/invariants.mjs', '--json'])
    try {
      const d = JSON.parse(r.out)
      // `unverified` is a declared invariant whose test exists and did NOT pass.
      // Counting it as covered would put the failure on the state page as a
      // success — the check's entire finding, discarded by its only consumer.
      const unverified = (d.unverified ?? []).map((u) => u.id)
      const uncovered = [...d.missingTest, ...unverified]
      return { declared: d.declared, covered: d.declared - uncovered.length, uncovered, undocumented: d.undocumented }
    } catch {
      return { error: 'invariant probe failed', detail: r.out.trim().slice(0, 400) }
    }
  },
}

/**
 * Every named test and whether it passed.
 *
 * Stored per name rather than as a total, because a total hides the case that
 * matters: one test flipping from pass to fail while another is added. The
 * key is `<repo-relative file> :: <qualified name>` — relative, so it is
 * identical on every machine (an absolute path is not, and that mismatch
 * would manufacture a phantom `test.removed` timeline entry any time a
 * snapshot was taken from a different checkout or machine) — and file-
 * qualified, so two files with an identically named test do not collide into
 * one entry.
 */
export const tests = {
  name: 'tests',
  measure: (ctx) => {
    const root = ctx?.root ?? ROOT
    const relFiles = discoverTestFiles(root).map((f) => relative(root, f))
    const byName = {}
    for (const { file, qualifiedName, state } of runSuite(root, relFiles).leaves) {
      byName[`${file} :: ${qualifiedName}`] = state
    }
    return { byName, failing: Object.entries(byName).filter(([, v]) => v === 'fail').map(([k]) => k) }
  },
}

/** Whether the coupling rules currently hold, and which do not. */
export const coupling = {
  name: 'coupling',
  measure: () => {
    const r = run('node', ['tools/agentic/gate.mjs', '--json'])
    try {
      const d = JSON.parse(r.out)
      // A refusal carries `error` and an empty `violations`, so reading only
      // `violations` turns "the gate declined to measure anything" into "the
      // gate found nothing wrong" — the same false green the gate itself was
      // just taught to refuse, laundered one layer up.
      if (d.error) return { violations: [], error: d.error, measured: false }
      return {
        measured: true,
        violations: d.violations.map((v) => ({ rule: v.ruleId, bindings: v.bindings, required: v.required })),
      }
    } catch {
      return { violations: [], error: r.out.trim().slice(0, 200), measured: false }
    }
  },
}

/**
 * Size of each module, against the budget it is meant to stay inside.
 * Size is a proxy and a weak one, but an unbounded module is where an agent
 * stops being able to hold the whole thing at once, which is the real limit.
 */
export const modules = {
  name: 'modules',
  measure: ({ root, modulesDir = 'src', budget = 1200 }) => {
    let names = []
    try {
      names = readdirSync(join(root, modulesDir)).filter((n) => statSync(join(root, modulesDir, n)).isDirectory())
    } catch {
      return {}
    }
    return Object.fromEntries(
      names.sort().map((n) => {
        const files = walk(join(root, modulesDir, n))
        const lines = files.reduce((t, f) => t + readFileSync(f, 'utf8').split('\n').length, 0)
        return [n, { files: files.length, lines, budget, overBudget: lines > budget }]
      }),
    )
  },
}

export const builtins = { invariants, tests, coupling, modules }
