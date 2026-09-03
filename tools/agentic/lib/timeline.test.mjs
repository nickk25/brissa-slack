import assert from 'node:assert/strict'
import { test } from 'node:test'
import { diff, health, openRegressions, refuseDirty } from './timeline.mjs'

const snap = (sha, probes) => ({ ts: '2026-09-02T00:00:00.000Z', sha, subject: sha, probes })
const withTests = (sha, byName) => snap(sha, { tests: { byName, failing: Object.entries(byName).filter(([, v]) => v === 'fail').map(([k]) => k) } })
const withModules = (sha, modules) => snap(sha, { modules })
const withCoupling = (sha, violations) => snap(sha, { coupling: { violations } })

test('INV-timeline-01 a snapshot that changed nothing measurable produces no entries', () => {
  // The point of the whole file. A log of commits says the agents were busy; this
  // says whether the software moved, and they are different questions.
  const a = withTests('aaa', { one: 'pass' })
  const b = withTests('bbb', { one: 'pass' })
  assert.deepEqual(diff(a, b), [])
})

test('INV-timeline-02 a test flipping either way is a transition with derived severity', () => {
  const broke = diff(withTests('a', { one: 'pass' }), withTests('b', { one: 'fail' }))
  assert.equal(broke.length, 1)
  assert.equal(broke[0].severity, 'down')

  const fixed = diff(withTests('b', { one: 'fail' }), withTests('c', { one: 'pass' }))
  assert.equal(fixed[0].severity, 'up')
})

test('INV-timeline-03 a test that arrives already failing is a regression, not a neutral addition', () => {
  const entries = diff(withTests('a', {}), withTests('b', { fresh: 'fail' }))
  assert.equal(entries.length, 1)
  assert.equal(entries[0].severity, 'down')
})

test('INV-timeline-04 something that appears already working is neutral, never an improvement', () => {
  // Otherwise the cheapest way to manufacture progress is to declare things that
  // already pass, and anything gameable into looking like progress eventually is.
  const before = snap('a', { invariants: { declared: 1, covered: 1, uncovered: [], undocumented: [] } })
  const after = snap('b', { invariants: { declared: 2, covered: 2, uncovered: [], undocumented: [] } })
  const entries = diff(before, after)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].severity, 'neutral')
})

test('INV-timeline-05 a regression stays open until the same subject recovers', () => {
  const entries = [
    ...diff(withTests('a', { one: 'pass' }), withTests('b', { one: 'fail' })),
    ...diff(withTests('b', { one: 'fail' }), withTests('c', { one: 'pass' })),
  ]
  assert.equal(openRegressions(entries).length, 0)
  assert.equal(openRegressions(entries.slice(0, 1)).length, 1)
})

test('INV-timeline-07 a renamed test is recorded as a neutral rename, not a regression', () => {
  // One old name vanishes while it was passing and one new name appears
  // already passing, in the same diff, with the counts matching (1 and 1):
  // that is treated as a rename. It still shows up in the raw timeline (for
  // audit), just as `test.renamed`/`neutral` rather than `test.removed`/
  // `down`, and it was never going to leave anything open.
  const entries = diff(withTests('a', { old: 'pass' }), withTests('b', { new: 'pass' }))
  assert.equal(entries.length, 1)
  assert.equal(entries[0].kind, 'test.renamed')
  assert.equal(entries[0].severity, 'neutral')
  assert.equal(openRegressions(entries).length, 0)
})

test('INV-timeline-08 a removed subject clears any open regression already recorded against it', () => {
  // The same defect as the renamed test, on the module side: module.budget can
  // leave a `down` open, and deleting the module entirely (module.removed,
  // itself neutral) must clear it too, or a module that no longer exists
  // could stay "over budget" forever.
  const small = { core: { lines: 10, budget: 1000, overBudget: false } }
  const big = { core: { lines: 1500, budget: 1000, overBudget: true } }
  const entries = [
    ...diff(withModules('a', small), withModules('b', big)),
    ...diff(withModules('b', big), withModules('c', {})),
  ]
  // Sanity check: the regression really was open right up until the removal.
  assert.equal(openRegressions(entries.slice(0, 1)).length, 1)
  assert.equal(openRegressions(entries).length, 0)
})

test("INV-timeline-09 different transition kinds on the same subject do not clear each other's regressions", () => {
  // Entries built directly rather than via diff(), to test the key itself in
  // isolation: keying regressions only by kind.split('.')[0] would collapse
  // every module.* kind onto one key, so this made-up module.added "up" would
  // wrongly clear a real module.budget regression on the same module.
  const budgetDown = { kind: 'module.budget', subject: 'core', severity: 'down' }
  const unrelatedUp = { kind: 'module.added', subject: 'core', severity: 'up' }
  assert.deepEqual(openRegressions([budgetDown, unrelatedUp]), [budgetDown])
})

test('INV-timeline-10 an invariant regaining coverage still closes its open regression', () => {
  // invariant.uncovered and invariant.covered record one regression under a
  // different verb per direction; both must resolve the same open regression.
  const clean = snap('a', { invariants: { declared: 1, covered: 1, uncovered: [], undocumented: [] } })
  const uncovered = snap('b', { invariants: { declared: 1, covered: 0, uncovered: ['INV-x'], undocumented: [] } })
  const covered = snap('c', { invariants: { declared: 1, covered: 1, uncovered: [], undocumented: [] } })
  const entries = [...diff(clean, uncovered), ...diff(uncovered, covered)]
  assert.equal(openRegressions(entries).length, 0)
})

test('INV-timeline-11 a dirty working tree is refused by default, and only proceeds with explicit opt-in', () => {
  // A snapshot stamped with HEAD while measuring an uncommitted tree silently
  // misattributes those changes to that commit. Refusing by default is the
  // only way a snapshot can be trusted; the opt-in exists so local
  // experimentation isn't blocked, not so dirt can pass as clean.
  assert.equal(refuseDirty(false, false), null)
  assert.equal(refuseDirty(true, true), null)
  assert.equal(typeof refuseDirty(true, false), 'string')
})

test('INV-timeline-12 deleting a failing test does not clear its regression', () => {
  // Retiring a vanished subject is right when it was healthy and simply no
  // longer exists to check. Applied to a FAILING subject it makes deletion the
  // cheapest repair available, which is the shortcut an agent will find first.
  const withTests = (sha, byName) => ({
    ts: '2026-09-02T00:00:00.000Z', sha, subject: sha,
    probes: { tests: { byName, failing: Object.entries(byName).filter(([, v]) => v === 'fail').map(([k]) => k) } },
  })
  const entries = [
    ...diff(withTests('a', { one: 'pass' }), withTests('b', { one: 'fail' })),
    ...diff(withTests('b', { one: 'fail' }), withTests('c', {})),
  ]
  assert.equal(openRegressions(entries).length, 1, 'the regression survives the deletion')
})

test('INV-timeline-13 removing a healthy subject does retire its record', () => {
  const snap = (sha, mods) => ({ ts: '2026-09-02T00:00:00.000Z', sha, subject: sha, probes: { modules: mods } })
  const entries = [
    ...diff(snap('a', { core: { lines: 10, budget: 5, overBudget: false } }),
            snap('b', { core: { lines: 99, budget: 5, overBudget: true } })),
    ...diff(snap('b', { core: { lines: 99, budget: 5, overBudget: true } }), snap('c', {})),
  ]
  assert.equal(openRegressions(entries).length, 0)
})

test('INV-timeline-14 health reports only snapshots and open regressions, nothing cumulative', () => {
  // No `improvements`, `regressions` or transition rate: a running total only
  // ever grows, so it reads the same for a repository with a long healthy
  // history and one that just broke a lot of things, and a per-snapshot rate
  // reads the same for "nothing to fix" as for "fixing nothing".
  // openRegressions is the number worth reading — it already answers "is
  // anything broken right now" — so it is the only one kept.
  const entries = diff(withTests('a', { one: 'fail' }), withTests('b', { one: 'pass' }))
  const h = health(entries, 4)
  assert.deepEqual(Object.keys(h).sort(), ['openRegressions', 'snapshots'])
  assert.equal(h.snapshots, 4)
  assert.equal(h.openRegressions, 0)
})

test('INV-timeline-15 a mass rename of many passing tests produces neutral entries, never a wall of down', () => {
  const before = withTests('a', { t1: 'pass', t2: 'pass', t3: 'pass' })
  const after = withTests('b', { t1_new: 'pass', t2_new: 'pass', t3_new: 'pass' })
  const entries = diff(before, after)
  assert.equal(entries.length, 3)
  assert.ok(entries.every((e) => e.kind === 'test.renamed' && e.severity === 'neutral'))
  assert.equal(openRegressions(entries).length, 0)
})

test('INV-timeline-16 removals in excess of the matching additions still report as regressions', () => {
  // Two names vanish, only one replacement appears: at most one of the
  // vanished names can be presumed carried over by count alone, so the other
  // is reported as a genuine removal rather than folded into the rename.
  const before = withTests('a', { t1: 'pass', t2: 'pass' })
  const after = withTests('b', { t1_new: 'pass' })
  const entries = diff(before, after)
  const renamed = entries.filter((e) => e.kind === 'test.renamed')
  const removed = entries.filter((e) => e.kind === 'test.removed')
  assert.equal(renamed.length, 1)
  assert.equal(removed.length, 1)
  assert.equal(removed[0].severity, 'down')
})

test('INV-timeline-17 a genuine failure still reports as a regression in a diff that also contains a rename', () => {
  const before = withTests('a', { old: 'pass', stable: 'pass' })
  const after = withTests('b', { new_name: 'pass', stable: 'fail' })
  const entries = diff(before, after)
  const renamed = entries.find((e) => e.kind === 'test.renamed')
  const broken = entries.find((e) => e.subject === 'stable')
  assert.ok(renamed, 'the rename is still detected')
  assert.equal(broken.kind, 'test.flip')
  assert.equal(broken.severity, 'down')
  assert.equal(openRegressions(entries).length, 1)
})

test('INV-timeline-18 a failing test that disappears is never mistaken for a rename', () => {
  // Only a passing subject can be presumed carried over under a new name; a
  // failing subject's disappearance is a removal, matching count or not,
  // because folding it into a rename would let deleting a failing test pass
  // as neutral instead of the regression-preserving removal INV-timeline-12
  // and INV-timeline-16 both require.
  const before = withTests('a', { broken: 'fail' })
  const after = withTests('b', { fresh: 'pass' })
  const entries = diff(before, after)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].kind, 'test.removed')
  assert.equal(entries[0].subject, 'broken')
  assert.equal(entries[0].severity, 'down')
})

test('INV-timeline-19 a new coupling violation opens as a regression, and its disappearance closes it', () => {
  // `before?.probes?.coupling` / `after.probes?.coupling?.violations` had no
  // test anywhere before this one -- the whole "coupling" section of diff()
  // ran on every real snapshot, unverified.
  const violation = { rule: 'module-contract', bindings: { module: 'core' } }
  const clean = withCoupling('a', [])
  const violated = withCoupling('b', [violation])
  const fixed = withCoupling('c', [])

  const opened = diff(clean, violated)
  assert.equal(opened.length, 1)
  assert.equal(opened[0].kind, 'coupling.opened')
  assert.equal(opened[0].severity, 'down')

  const closed = diff(violated, fixed)
  assert.equal(closed.length, 1)
  assert.equal(closed[0].kind, 'coupling.closed')
  assert.equal(closed[0].severity, 'up')

  assert.equal(openRegressions([...opened, ...closed]).length, 0)
})

test('INV-timeline-20 two violations of the same rule with different captures are distinct subjects', () => {
  const core = { rule: 'module-contract', bindings: { module: 'core' } }
  const llm = { rule: 'module-contract', bindings: { module: 'llm' } }
  const entries = diff(withCoupling('a', [core]), withCoupling('b', [core, llm]))
  assert.equal(entries.length, 1, 'the pre-existing violation on core must not be reported again')
  assert.equal(entries[0].kind, 'coupling.opened')
  assert.match(entries[0].subject, /llm/)
})

test('INV-timeline-21 the very first snapshot reports no declared-count entry, having nothing to compare against', () => {
  // `bInv && typeof bInv.declared === 'number' && ...` guards this: with no
  // `before` snapshot at all, `bInv` is undefined, and reading `.declared`
  // off it must never be attempted.
  const first = snap('a', { invariants: { declared: 3, covered: 3, uncovered: [], undocumented: [] } })
  assert.deepEqual(diff(null, first), [])
})

test('INV-timeline-22 an unchanged declared count between two real snapshots produces no entry', () => {
  const before = snap('a', { invariants: { declared: 2, covered: 2, uncovered: [], undocumented: [] } })
  const after = snap('b', { invariants: { declared: 2, covered: 2, uncovered: [], undocumented: [] } })
  assert.deepEqual(diff(before, after), [])
})
