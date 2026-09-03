/**
 * The timeline: what actually changed between two snapshots.
 *
 * An entry is a state transition, not a commit. A merge that moves nothing
 * measurable produces no entries and is invisible here — deliberately. A log of
 * commits tells you the agents were busy; this tells you whether the software
 * got better, and those are different questions with different answers.
 *
 * Severity is derived, never chosen. Nothing in this file asks anyone's opinion
 * about whether a change was good.
 *
 * One rule worth naming: something that appears already working is `neutral`,
 * not `up`. Otherwise the cheapest way to manufacture progress is to declare
 * things that already pass, and anything that can be gamed to look like progress
 * eventually is.
 */

import { createHash } from 'node:crypto'

// Joined on NUL, not a space: a kind or subject containing a space would
// otherwise be able to collide with a different pair. Written as an escape
// rather than a raw byte — a literal NUL makes the file binary to `file`,
// `grep` and, the one that actually matters here, `git diff`, which turns the
// review surface of an agent-maintained repository into "Binary files differ".
const id = (parts) => createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 12)

const keys = (o) => Object.keys(o ?? {})
const setOf = (a) => new Set(a ?? [])

/**
 * @typedef {Object} Entry
 * @property {string} id
 * @property {string} ts
 * @property {string} kind
 * @property {string} subject
 * @property {unknown} [from]
 * @property {unknown} [to]
 * @property {'up'|'down'|'neutral'} severity
 * @property {string[]} evidence
 */

/**
 * @param {any} before  previous snapshot, or null for the first one
 * @param {any} after   the snapshot just taken
 * @returns {Entry[]}
 */
export function diff(before, after) {
  /** @type {Entry[]} */
  const entries = []
  const ts = after.ts
  const pair = [before?.sha ?? 'genesis', after.sha]

  const push = (kind, subject, severity, extra = {}) =>
    entries.push({ id: id([kind, subject, ...pair]), ts, kind, subject, severity, evidence: [], ...extra })

  // ---- invariants -----------------------------------------------------------
  const bInv = before?.probes?.invariants
  const aInv = after.probes?.invariants
  if (aInv && !aInv.error) {
    const wasUncovered = setOf(bInv?.uncovered)
    const isUncovered = setOf(aInv.uncovered)

    for (const inv of isUncovered) {
      if (!wasUncovered.has(inv)) {
        push('invariant.uncovered', inv, 'down', { from: 'covered', to: 'uncovered' })
      }
    }
    for (const inv of wasUncovered) {
      if (!isUncovered.has(inv)) {
        push('invariant.covered', inv, 'up', { from: 'uncovered', to: 'covered' })
      }
    }

    // A declared invariant that arrives already covered is bookkeeping, not an
    // achievement. Counting it as progress makes declaring easy claims the
    // cheapest way to look productive.
    if (bInv && typeof bInv.declared === 'number' && aInv.declared !== bInv.declared) {
      push('invariant.count', 'declared', 'neutral', { from: bInv.declared, to: aInv.declared })
    }
  }

  // ---- tests ------------------------------------------------------------
  const bTests = before?.probes?.tests?.byName ?? {}
  const aTests = after.probes?.tests?.byName ?? {}

  for (const name of keys(aTests)) {
    const was = bTests[name]
    const is = aTests[name]
    if (was && was !== is) {
      push('test.flip', name, is === 'pass' ? 'up' : 'down', { from: was, to: is })
    } else if (!was && is === 'fail') {
      // Landing a failing test is a regression however new it is.
      push('test.flip', name, 'down', { from: 'absent', to: 'fail' })
    }
  }

  // A vanished name and a fresh name carry no shared identity across two
  // snapshots — no path, no hash of the test body, nothing but the name
  // itself, and the name is exactly what changed. So "the same test under a
  // new name" can only ever be a guess, and the guess made here is: when a
  // passing name disappears and a passing name appears in the same diff, and
  // the counts match, treat that many disappearances as renames rather than
  // as removals. Pairing is arbitrary (there is no signal to pair on), only
  // the count is used. This is wrong exactly when an unrelated deletion and
  // an unrelated addition land in the same diff with the same count — rare,
  // and no worse than today: a newly-added passing test already produces no
  // entry at all (the "already working is neutral" rule above), so the
  // addition side of that coincidence was always invisible on its own. The
  // alternative — reporting every disappearance as `down` — is wrong on
  // every routine rename, which is not rare, so this trades an unlikely
  // false neutral for a guaranteed false alarm. A test that was failing when
  // it disappeared is never matched into a rename: only a passing subject
  // can be presumed carried over, so a failing test's disappearance still
  // reports as a plain removal below.
  const removedNames = keys(bTests).filter((name) => !(name in aTests))
  const removedPassing = removedNames.filter((name) => bTests[name] === 'pass')
  const addedPassing = keys(aTests).filter((name) => !(name in bTests) && aTests[name] === 'pass')
  const renamed = new Set(removedPassing.slice(0, Math.min(removedPassing.length, addedPassing.length)))

  for (const name of removedNames) {
    if (renamed.has(name)) push('test.renamed', name, 'neutral', { from: 'pass', to: 'presumed renamed' })
    else push('test.removed', name, 'down', { from: bTests[name], to: 'absent' })
  }

  // ---- coupling -------------------------------------------------------------
  const key = (v) => `${v.rule}${Object.keys(v.bindings ?? {}).length ? ` (${Object.values(v.bindings).join(',')})` : ''}`
  const bViol = new Set((before?.probes?.coupling?.violations ?? []).map(key))
  const aViol = new Set((after.probes?.coupling?.violations ?? []).map(key))
  for (const v of aViol) if (!bViol.has(v)) push('coupling.opened', v, 'down', { to: 'violated' })
  for (const v of bViol) if (!aViol.has(v)) push('coupling.closed', v, 'up', { from: 'violated' })

  // ---- modules --------------------------------------------------------------
  const bMods = before?.probes?.modules ?? {}
  const aMods = after.probes?.modules ?? {}
  for (const name of keys(aMods)) {
    const was = bMods[name]
    const is = aMods[name]
    if (!was) push('module.added', name, 'neutral', { to: `${is.lines} lines` })
    else if (was.overBudget !== is.overBudget) {
      push('module.budget', name, is.overBudget ? 'down' : 'up', {
        from: `${was.lines} lines`,
        to: `${is.lines} lines of ${is.budget}`,
      })
    }
  }
  for (const name of keys(bMods)) if (!(name in aMods)) push('module.removed', name, 'neutral')

  return entries
}

/**
 * What regression a transition kind belongs to, and whether the kind means
 * the subject itself is gone rather than merely re-measured.
 *
 * A `family` groups kinds that record one regression under a different verb
 * per direction — `invariant.uncovered`/`covered`, `coupling.opened`/`closed`
 * — so the `up` variant can close the `down` variant's regression; a kind
 * missing from this table is its own family (its own kind name). `gone: true`
 * marks a kind whose subject can never be re-measured: such a subject retires
 * whatever regression is open against it instead of waiting for an `up` that
 * can never arrive, and is not itself recorded as a new regression — a
 * subject that disappeared was never observed to improve, and inventing an
 * `up` for it would be exactly the kind of narrated, unmeasured claim this
 * file exists to refuse. `openRegressions` below carries the one exception:
 * a subject that was failing when it vanished still keeps its regression
 * open, because deletion is not a repair.
 */
const REGRESSION = {
  'invariant.uncovered': { family: 'invariant.coverage' },
  'invariant.covered': { family: 'invariant.coverage' },
  'coupling.opened': { family: 'coupling.violation' },
  'coupling.closed': { family: 'coupling.violation' },
  'test.removed': { gone: true },
  'module.removed': { gone: true },
}
const regressionOf = (kind) => {
  const r = REGRESSION[kind]
  return { family: r?.family ?? kind, gone: r?.gone === true }
}

/**
 * Regressions still open: a `down` with no later `up` on the same subject.
 *
 * This is the number to read first. A repository can produce a great deal of
 * activity while this climbs, and that combination is the thing worth catching
 * early — it means the agents are fixing things by breaking others.
 *
 * @param {Entry[]} entries  oldest first
 */
export function openRegressions(entries) {
  /** @type {Map<string, Entry>} */
  const open = new Map()
  for (const e of entries) {
    const { family, gone } = regressionOf(e.kind)
    if (gone) {
      // '\0' can't appear in a kind or subject string, so it is a safe
      // separator: the same convention this file's own id() already uses.
      for (const [k, open_] of open) {
        if (k.slice(k.indexOf('\0') + 1) !== e.subject) continue
        // A subject that was passing and then vanished has nothing left to
        // check. A subject that was FAILING and then vanished was deleted, and
        // deletion is not a repair — retiring it here would make "delete the
        // failing test" the cheapest way to clear a regression, which is the
        // single most tempting shortcut available to an agent.
        if (open_.to !== 'fail') open.delete(k)
      }
      continue
    }
    const k = `${family}\0${e.subject}`
    if (e.severity === 'down') open.set(k, e)
    else if (e.severity === 'up') open.delete(k)
  }
  return [...open.values()]
}

/**
 * Whether a snapshot may be taken as measured, given whether the working tree
 * has uncommitted changes and whether the caller opted in anyway.
 *
 * Pulled out as a pure function so the refusal rule has a test that needs no
 * real git repository — state.mjs owns running `git status --porcelain`; this
 * just decides what to do with the answer.
 *
 * @param {boolean} dirty       true when the working tree has uncommitted changes
 * @param {boolean} allowDirty  explicit opt-in from the caller
 * @returns {string | null}     a refusal message, or null if the snapshot may proceed
 */
export function refuseDirty(dirty, allowDirty) {
  if (!dirty || allowDirty) return null
  return (
    'Refusing to snapshot: the working tree has uncommitted changes, so a snapshot ' +
    'stamped with HEAD would measure changes that commit never contained. Commit first, ' +
    'or pass --allow-dirty to record one anyway (it will be marked "dirty": true).'
  )
}

/**
 * The only two numbers about the whole timeline worth reporting at a glance.
 *
 * `snapshots` is the sample size the rest of the state page's numbers should
 * be read against. `openRegressions` is deliberately the only health number
 * kept here: a cumulative count of every `down`/`up` ever seen only grows
 * and never falls, so a single mass rename or a long healthy history both
 * inflate it the same way a real defect would, and a reader cannot tell
 * "a lot happened" from "a lot broke" without re-deriving `openRegressions`
 * anyway. `openRegressions` already answers the one question that matters —
 * is anything broken right now — so it is kept and nothing else is.
 *
 * @param {Entry[]} entries
 * @param {number} snapshots
 */
export function health(entries, snapshots) {
  return { snapshots, openRegressions: openRegressions(entries).length }
}
