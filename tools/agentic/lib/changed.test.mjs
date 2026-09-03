import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { added, changedFiles, present, resolveRange, touched } from './changed.mjs'

// changed.mjs had no direct test file at all before this one: every one of its
// functions was exercised only indirectly, through coupling.test.mjs calling
// `evaluate()`. That hid the fact that `resolveRange`'s primary path — the one
// CI actually takes, base and head coming from the pull request event — had
// no test anywhere: only the local, no-event fallback (merge-base / no-base)
// was ever driven directly (see INV-coupling-13).

function makeRepo() {
  // See coupling.test.mjs for why this is resolved with realpathSync.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'changed-test-')))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  return { root, git }
}

function withEnv(vars, fn) {
  const saved = {}
  for (const k of Object.keys(vars)) saved[k] = process.env[k]
  try {
    Object.assign(process.env, vars)
    return fn()
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

// `resolveRange` consults AGENTIC_BASE_SHA / AGENTIC_HEAD_SHA before it looks at
// git at all, so any test about the *fallback* paths has to run with them unset.
// CI sets both for the gate step, which is how this was found: these tests
// passed locally and failed there, which is the wrong way round for a test to
// be wrong.
function withoutEventEnv(fn) {
  const saved = { base: process.env.AGENTIC_BASE_SHA, head: process.env.AGENTIC_HEAD_SHA }
  delete process.env.AGENTIC_BASE_SHA
  delete process.env.AGENTIC_HEAD_SHA
  try {
    return fn()
  } finally {
    if (saved.base !== undefined) process.env.AGENTIC_BASE_SHA = saved.base
    if (saved.head !== undefined) process.env.AGENTIC_HEAD_SHA = saved.head
  }
}

test('INV-changed-01 explicit base and head resolve to an event-sourced range, opts winning over the environment', () => {
  withEnv({ AGENTIC_BASE_SHA: 'env-base', AGENTIC_HEAD_SHA: 'env-head' }, () => {
    const r = resolveRange({ base: 'opt-base', head: 'opt-head' })
    assert.deepEqual(r, { base: 'opt-base', head: 'opt-head', source: 'event' })
  })
})

test('INV-changed-02 base and head fall back to the environment when opts supplies neither', () => {
  withEnv({ AGENTIC_BASE_SHA: 'env-base', AGENTIC_HEAD_SHA: 'env-head' }, () => {
    // A `??`-to-`&&` mutation of either fallback would make this undefined
    // instead of the environment value, since opts.base/opts.head are absent
    // here (falsy but not what `&&` cares about) rather than merely falsy.
    const r = resolveRange({})
    assert.deepEqual(r, { base: 'env-base', head: 'env-head', source: 'event' })
  })
})

test('INV-changed-03 only one of base/head present must not resolve as an event-sourced range', () => {
  const { root, git } = makeRepo()
  const cwd = process.cwd()
  try {
    writeFileSync(join(root, 'a.txt'), 'a')
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    process.chdir(root)

    withEnv({ AGENTIC_BASE_SHA: '', AGENTIC_HEAD_SHA: 'only-head' }, () => {
      delete process.env.AGENTIC_BASE_SHA
      const r = resolveRange({})
      assert.notEqual(r.source, 'event', 'one side missing must fall through to the local range, not the event one')
    })
  } finally {
    process.chdir(cwd)
    rmSync(root, { recursive: true, force: true })
  }
})

test('INV-changed-04 a resolvable merge-base is reported with source "merge-base"', () => {
  const { root, git } = makeRepo()
  const cwd = process.cwd()
  try {
    writeFileSync(join(root, 'a.txt'), 'a')
    git('add', '-A')
    git('commit', '-q', '-m', 'init on main')
    git('checkout', '-q', '-b', 'feature')
    writeFileSync(join(root, 'b.txt'), 'b')
    git('add', '-A')
    git('commit', '-q', '-m', 'feature commit')
    process.chdir(root)

    const r = withoutEventEnv(() => resolveRange({ defaultBranch: 'main' }))
    assert.equal(r.source, 'merge-base')
    assert.ok(r.base, 'a real merge base commit must be reported, not left empty')
  } finally {
    process.chdir(cwd)
    rmSync(root, { recursive: true, force: true })
  }
})

test('INV-changed-05 with no default branch to compare against, the range is reported with source "no-base"', () => {
  const { root, git } = makeRepo()
  const cwd = process.cwd()
  try {
    writeFileSync(join(root, 'a.txt'), 'a')
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    process.chdir(root)

    // No branch by this name exists, so `git merge-base` fails and this falls
    // to the "everything is new" path — see INV-coupling-13, which checks the
    // resulting change set; this checks the range's own `source` label.
    const r = withoutEventEnv(() => resolveRange({ defaultBranch: 'no-such-branch' }))
    assert.equal(r.source, 'no-base')
    assert.equal(r.base, null)
  } finally {
    process.chdir(cwd)
    rmSync(root, { recursive: true, force: true })
  }
})

test('INV-changed-06 changedFiles reports one entry per changed path, tagged with its real status', () => {
  const { root, git } = makeRepo()
  const cwd = process.cwd()
  try {
    writeFileSync(join(root, 'a.txt'), 'a')
    writeFileSync(join(root, 'b.txt'), 'b')
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    const base = git('rev-parse', 'HEAD').trim()

    writeFileSync(join(root, 'a.txt'), 'a2') // modified
    writeFileSync(join(root, 'c.txt'), 'c') // added
    rmSync(join(root, 'b.txt')) // deleted
    git('add', '-A')
    git('commit', '-q', '-m', 'change')
    const head = git('rev-parse', 'HEAD').trim()

    process.chdir(root)
    const changes = changedFiles({ base, head, source: 'event' })
    const byPath = Object.fromEntries(changes.map((c) => [c.path, c.status]))
    assert.deepEqual(byPath, { 'a.txt': 'M', 'b.txt': 'D', 'c.txt': 'A' })
  } finally {
    process.chdir(cwd)
    rmSync(root, { recursive: true, force: true })
  }
})

test('INV-changed-07 with no base, changedFiles diffs the empty tree against head, not the working tree', () => {
  // A regression guard on the EMPTY_TREE constant itself, and on the branch
  // that picks it: get either wrong and this stops diffing "nothing" against
  // head and starts diffing something else, changing which paths (and how
  // many) come back — see INV-coupling-13 for the same fact checked one layer
  // up, through evaluate().
  const { root, git } = makeRepo()
  const cwd = process.cwd()
  try {
    writeFileSync(join(root, 'a.txt'), 'a')
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    const head = git('rev-parse', 'HEAD').trim()
    process.chdir(root)
    const changes = changedFiles({ base: null, head, source: 'no-base' })
    assert.deepEqual(changes, [{ status: 'A', path: 'a.txt' }])
  } finally {
    process.chdir(cwd)
    rmSync(root, { recursive: true, force: true })
  }
})

test('INV-changed-08 touched/present/added derive exactly the right path lists from a mixed change set', () => {
  const changes = [
    { status: 'A', path: 'new.txt' },
    { status: 'M', path: 'edited.txt' },
    { status: 'D', path: 'gone.txt' },
  ]
  assert.deepEqual(touched(changes), ['new.txt', 'edited.txt', 'gone.txt'])
  assert.deepEqual(present(changes), ['new.txt', 'edited.txt'])
  assert.deepEqual(added(changes), ['new.txt'])
})
