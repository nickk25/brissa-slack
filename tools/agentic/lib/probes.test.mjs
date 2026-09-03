import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { discoverTestFiles, testConfig } from '../probes/index.mjs'

function fixture(pkg, files = []) {
  const root = mkdtempSync(join(tmpdir(), 'probes-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify(pkg))
  for (const f of files) {
    mkdirSync(dirname(join(root, f)), { recursive: true })
    writeFileSync(join(root, f), '')
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const rel = (root, paths) => paths.map((p) => p.slice(root.length + 1)).sort()

test('INV-probes-01 a project that declares nothing keeps this repository\'s own suite', () => {
  // The defaults have to stay exactly what they were, or adopting the engine
  // would change the meaning of every existing project's invariants.
  const f = fixture({ name: 'x' })
  try {
    assert.deepEqual(testConfig(f.root).files, ['tools/agentic/**/*.test.mjs'])
    assert.deepEqual(testConfig(f.root).nodeArgs, [])
  } finally {
    f.cleanup()
  }
})

test('INV-probes-02 a project declaring its own test globs is believed', () => {
  // Hard-coding a directory and an extension meant a project whose tests live
  // anywhere else had every invariant reported as untested on its first run.
  const f = fixture(
    { name: 'x', agentic: { tests: { files: ['src/**/*.test.ts'] } } },
    ['src/core/ask.test.ts', 'src/core/ask.ts', 'tools/agentic/lib/x.test.mjs'],
  )
  try {
    assert.deepEqual(rel(f.root, discoverTestFiles(f.root)), ['src/core/ask.test.ts'])
  } finally {
    f.cleanup()
  }
})

test('INV-probes-03 several globs are matched together, not one instead of the other', () => {
  // A project adopting the engine keeps its tests alongside its own.
  const f = fixture(
    { name: 'x', agentic: { tests: { files: ['tools/agentic/**/*.test.mjs', 'src/**/*.test.ts'] } } },
    ['src/core/ask.test.ts', 'tools/agentic/lib/x.test.mjs', 'README.md'],
  )
  try {
    assert.deepEqual(rel(f.root, discoverTestFiles(f.root)), ['src/core/ask.test.ts', 'tools/agentic/lib/x.test.mjs'])
  } finally {
    f.cleanup()
  }
})

test('INV-probes-04 node arguments a project declares are carried through', () => {
  // TypeScript needs a flag to run at all; without this the suite is discovered
  // and then fails to execute, which reads as every test having failed.
  const f = fixture({ name: 'x', agentic: { tests: { nodeArgs: ['--experimental-strip-types'] } } })
  try {
    assert.deepEqual(testConfig(f.root).nodeArgs, ['--experimental-strip-types'])
  } finally {
    f.cleanup()
  }
})

test('INV-probes-05 a malformed declaration falls back rather than discovering nothing', () => {
  // Discovering nothing looks identical to a project with no tests, and would
  // silently pass every invariant it could not check.
  const f = fixture({ name: 'x', agentic: { tests: { files: 'src/**/*.test.ts' } } })
  try {
    assert.deepEqual(testConfig(f.root).files, ['tools/agentic/**/*.test.mjs'])
  } finally {
    f.cleanup()
  }
})
