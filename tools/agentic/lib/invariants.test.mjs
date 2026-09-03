import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTap, tests as testsProbe } from '../probes/index.mjs'

// invariants.mjs is exercised end to end, as a real subprocess, against a
// throwaway fixture repository under os.tmpdir() — never against fixtures
// added to this repository. Each fixture reproduces one specific way a test
// title's id can fail to genuinely back a declared claim: living outside the
// tree that actually gets tested, sitting in a test that fails, or sitting in
// a test that's skipped.
//
// There is no fixture here for an "orphan id" (one belonging to no test at
// all): an id lives inside a test's own title string, and a title string has
// no position to occupy except inside a real `test(...)` call, so that state
// cannot arise structurally and has nothing to reproduce.

const INVARIANTS = fileURLToPath(new URL('../invariants.mjs', import.meta.url))
// Fixture ids are assembled through this helper rather than written out
// literally. This file's fixtures are example contracts and example test
// files built as strings, and the real invariants.mjs — when it scans this
// actual repository — reads raw source text, not JavaScript semantics: it
// cannot tell a template-literal expression from a real test title. Spelling
// a fixture id out literally next to `test('` would make this file's own
// fixture-construction code look like a genuine, undeclared invariant in this
// repo's own tree, and this suite would permanently poison the very check it
// exists to verify.
const fid = (n) => `INV-fixture-${n}`
const CLAIM = (id) => `- Some guarantee. \`test: ${id}\`\n`

const HEADER = "import assert from 'node:assert/strict'\nimport { test } from 'node:test'\n\n"

function makeFixtureRoot() {
  return mkdtempSync(join(tmpdir(), 'invariants-test-'))
}

function write(root, relPath, content) {
  const full = join(root, relPath)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

/** Runs the real invariants.mjs against `root` and returns its parsed --json output. */
function runInvariants(root) {
  try {
    const out = execFileSync('node', [INVARIANTS, '--json'], { cwd: root, encoding: 'utf8' })
    return JSON.parse(out)
  } catch (err) {
    // invariants.mjs exits 1 whenever it finds a problem; the JSON is still on stdout.
    return JSON.parse(err.stdout)
  }
}

test('INV-invariants-01 a declared id whose test lives outside the executed test tree does not satisfy the claim', () => {
  const root = makeFixtureRoot()
  try {
    write(root, 'CLAUDE.md', CLAIM(fid('01')))
    // Sits at the repo root, outside tools/agentic/** — the tree the real
    // `npm test` (and this tool) actually runs. An id here must not be able
    // to satisfy the claim just because the file's name ends in `.test.mjs`.
    write(root, 'rogue.test.mjs', `${HEADER}test('${fid('01')} rogue', () => {\n  assert.ok(true)\n})\n`)

    const result = runInvariants(root)
    assert.ok(result.missingTest.includes(fid('01')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('INV-invariants-02 a declared id whose test runs and fails does not satisfy the claim', () => {
  const root = makeFixtureRoot()
  try {
    write(root, 'CLAUDE.md', CLAIM(fid('02')))
    write(root, 'tools/agentic/lib/failing.test.mjs', `${HEADER}test('${fid('02')} will fail', () => {\n  assert.ok(false)\n})\n`)

    const result = runInvariants(root)
    assert.equal(result.missingTest.includes(fid('02')), false, 'the id exists in a title, so it is not simply "missing"')
    const entry = result.unverified.find((u) => u.id === fid('02'))
    assert.ok(entry, 'a failing test must not satisfy the declared invariant')
    assert.equal(entry.occurrences[0].state, 'fail')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('INV-invariants-03 a declared id whose test is skipped does not satisfy the claim', () => {
  const root = makeFixtureRoot()
  try {
    write(root, 'CLAUDE.md', CLAIM(fid('03')))
    write(
      root,
      'tools/agentic/lib/skipped.test.mjs',
      `${HEADER}test('${fid('03')} skipped', { skip: true }, () => {\n  assert.ok(true)\n})\n`,
    )

    const result = runInvariants(root)
    const entry = result.unverified.find((u) => u.id === fid('03'))
    assert.ok(entry, 'a skipped test must not satisfy the declared invariant')
    assert.equal(entry.occurrences[0].state, 'skip')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('INV-invariants-05 duplicate test names across different files do not collide in the tests probe', () => {
  const root = makeFixtureRoot()
  try {
    write(root, 'tools/agentic/lib/a.test.mjs', `${HEADER}test('same name', () => {\n  assert.ok(true)\n})\n`)
    write(root, 'tools/agentic/lib/b.test.mjs', `${HEADER}test('same name', () => {\n  assert.ok(false)\n})\n`)

    const { byName } = testsProbe.measure({ root })
    const keys = Object.keys(byName).filter((k) => k.endsWith('same name'))
    assert.equal(keys.length, 2, 'each file must contribute its own entry for "same name"')
    const states = keys.map((k) => byName[k]).sort()
    assert.deepEqual(states, ['fail', 'pass'], 'the two identically-named tests must not overwrite one another')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('INV-invariants-06 parseTap records a SKIP directive as its own state, never as a pass, and strips it from the name', () => {
  const tap = [
    'TAP version 13',
    '# Subtest: skipped one',
    'ok 1 - skipped one # SKIP reason',
    '  ---',
    '  duration_ms: 0.1',
    '  ...',
    '1..1',
  ].join('\n')

  const leaves = parseTap(tap)
  assert.equal(leaves.length, 1)
  assert.equal(leaves[0].name, 'skipped one')
  assert.equal(leaves[0].state, 'skip')
})

test('INV-invariants-07 parseTap does not count a describe() suite’s own summary line as a test', () => {
  const tap = [
    'TAP version 13',
    '# Subtest: a suite',
    '    # Subtest: inner',
    '    ok 1 - inner',
    '      ---',
    '      duration_ms: 0.1',
    '      ...',
    '    1..1',
    "ok 1 - a suite",
    '  ---',
    '  duration_ms: 0.2',
    "  type: 'suite'",
    '  ...',
    '1..1',
  ].join('\n')

  const leaves = parseTap(tap)
  assert.equal(leaves.length, 1, 'the suite line itself must not be counted as a test')
  assert.equal(leaves[0].qualifiedName, 'a suite > inner')
  assert.equal(leaves[0].state, 'pass')
})

test('INV-invariants-09 a declared id whose test actually ran and passed satisfies the claim', () => {
  const root = makeFixtureRoot()
  try {
    write(root, 'CLAUDE.md', CLAIM(fid('09')))
    write(root, 'tools/agentic/lib/ok.test.mjs', `${HEADER}test('${fid('09')} passes', () => {\n  assert.ok(true)\n})\n`)

    const result = runInvariants(root)
    assert.equal(result.missingTest.includes(fid('09')), false)
    assert.equal(result.unverified.length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a test whose title carries no id is not treated as covering any invariant, and is not an error', () => {
  // Most tests will not make a formal claim at all. invariants.mjs must not
  // choke on that (a plain test is not malformed input) and must not let it
  // silently look like coverage of some invariant it never named. This test
  // carries no id itself, on purpose — it is an example of exactly the case
  // it describes.
  const root = makeFixtureRoot()
  try {
    write(root, 'tools/agentic/lib/plain.test.mjs', `${HEADER}test('just a regular test with no id in its title', () => {\n  assert.ok(true)\n})\n`)

    const result = runInvariants(root)
    assert.equal(result.tagged, 0, 'a title with no id contributes no occurrence at all')
    assert.deepEqual(result.undocumented, [])
    assert.deepEqual(result.missingTest, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('INV-invariants-10 an id carried by an it() test is recognised in both directions', () => {
  // `it` is a first-class export of node:test, so a scanner that only knows
  // `test(` leaves an entire dialect invisible — and an undeclared id there
  // would fall out of both directions and be reported nowhere at all.
  const root = makeFixtureRoot()
  try {
    write(root, 'package.json', '{"name":"f","type":"module"}')
    write(root, 'CLAUDE.md', CLAIM(fid('10')))
    write(
      root,
      'tools/agentic/lib/it.test.mjs',
      `import assert from 'node:assert/strict'\nimport { it } from 'node:test'\n\nit('${fid('10')} covered by it', () => {\n  assert.ok(true)\n})\n`,
    )
    const result = runInvariants(root)
    assert.equal(result.missingTest.includes(fid('10')), false, 'an it() title backs a claim like a test() title does')
    assert.deepEqual(result.unverified, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('INV-invariants-12 a declared claim whose test fails is not reported as covered by the probe', () => {
  // The probe is the only programmatic consumer of this check. Counting an id
  // whose test failed as covered would put the failure on the state page as a
  // success, discarding the whole finding one layer up.
  const root = makeFixtureRoot()
  try {
    write(root, 'package.json', '{"name":"f","type":"module"}')
    write(root, 'CLAUDE.md', CLAIM(fid('12')))
    write(
      root,
      'tools/agentic/lib/failing.test.mjs',
      `${HEADER}test('${fid('12')} asserts something untrue', () => {\n  assert.equal(1, 2)\n})\n`,
    )
    const result = runInvariants(root)
    assert.ok(result.unverified.some((u) => u.id === fid('12')))
    assert.equal(result.declared - result.missingTest.length - result.unverified.length, 0, 'nothing is genuinely covered here')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
