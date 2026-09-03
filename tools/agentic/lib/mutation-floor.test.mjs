import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { judge } from '../mutation-floor.mjs'

const SCRIPT = fileURLToPath(new URL('../mutation-floor.mjs', import.meta.url))

/** A synthetic Stryker report: one entry per file, as a killed/total pair. */
function report(files) {
  const dir = mkdtempSync(join(tmpdir(), 'floor-'))
  const path = join(dir, 'mutation.json')
  writeFileSync(
    path,
    JSON.stringify({
      files: Object.fromEntries(
        Object.entries(files).map(([name, [killed, total]]) => [
          `lib/${name}`,
          { mutants: [...Array(killed).fill({ status: 'Killed' }), ...Array(total - killed).fill({ status: 'Survived' })] },
        ]),
      ),
    }),
  )
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function run(path) {
  try {
    return { code: 0, out: execFileSync('node', [SCRIPT, path], { encoding: 'utf8' }) }
  } catch (err) {
    return { code: err.status, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

test('INV-floor-01 a file below the floor fails the run, however good the average is', () => {
  // The whole reason this script exists: a global average lets a strong file
  // carry a weak one, and the number that gates CI never learns the difference.
  const r = report({ 'weak.mjs': [400, 1000], 'strong.mjs': [990, 1000] })
  try {
    const { code, out } = run(r.path)
    assert.equal(code, 1)
    assert.match(out, /weak\.mjs/)
  } finally {
    r.cleanup()
  }
})

test('INV-floor-02 a ratcheted file sitting exactly on its bar passes', () => {
  // 586/1000 is 58.599999999999994 in binary floating point, so an unrounded
  // comparison would fail a file by an error invisible in the report itself.
  const { failing } = judge([{ path: 'lib/timeline.mjs', score: 58.6 }], { 'timeline.mjs': 58.6 }, 65)
  assert.deepEqual(failing, [])
})

test('INV-floor-03 a ratcheted file that slips below its own score fails', () => {
  // A ratchet only earns its keep if it still catches a regression. Otherwise
  // it is an exemption with better manners.
  const { failing } = judge([{ path: 'lib/timeline.mjs', score: 50 }], { 'timeline.mjs': 58.6 }, 65)
  assert.deepEqual(failing.map((f) => f.path), ['lib/timeline.mjs'])
})

test('INV-floor-04 a ratcheted file that clears the floor is reported as ready to graduate', () => {
  // A stale pin silently holds a file to a lower bar than it can already meet.
  const { failing, graduated } = judge([{ path: 'lib/timeline.mjs', score: 80 }], { 'timeline.mjs': 58.6 }, 65)
  assert.deepEqual(failing, [])
  assert.deepEqual(graduated.map((f) => f.path), ['lib/timeline.mjs'])
})

test('INV-floor-07 an empty ratchet holds every file to the floor itself', () => {
  // The goal state. An entry is a temporary pin, not the normal way to pass.
  const { failing, graduated } = judge([{ path: 'lib/a.mjs', score: 64 }, { path: 'lib/b.mjs', score: 66 }], {}, 65)
  assert.deepEqual(failing.map((f) => f.path), ['lib/a.mjs'])
  assert.deepEqual(graduated, [])
})

test('INV-floor-05 a report naming no scoreable mutant is an error, not a pass', () => {
  // Nothing measured is not the same as nothing wrong — the same refusal the
  // gate and the contract checker already make.
  const r = report({})
  try {
    assert.equal(run(r.path).code, 2)
  } finally {
    r.cleanup()
  }
})

test('INV-floor-06 a missing report is an error that says to run the mutator first', () => {
  const { code, out } = run('/nonexistent/mutation.json')
  assert.equal(code, 2)
  assert.match(out, /npm run mutate/)
})

test('INV-floor-08 importing the module does not run the tool', () => {
  // These tests import it for `judge`. A module that runs itself on import turns
  // "borrow one function" into "run the whole tool", and it then fails wherever
  // the report is absent — which is everywhere except a machine that has just
  // run the mutator. It passed locally and failed in CI for exactly that reason.
  assert.equal(typeof judge, 'function', 'the import completed at all')
  const { failing } = judge([{ path: 'lib/x.mjs', score: 10 }], {}, 65)
  assert.equal(failing.length, 1, 'and the borrowed function works on its own')
})
