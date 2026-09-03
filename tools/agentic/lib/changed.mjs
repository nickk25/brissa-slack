/**
 * Which files this pull request changes.
 *
 * Knows nothing about the project that uses it.
 *
 * Compares two fixed SHAs, never branch names: `main` moves while a pull request
 * is open, so diffing against it pulls in commits the pull request never made.
 * Locally, with no pull request event around, it falls back to the merge base
 * with the default branch.
 */

import { execFileSync } from 'node:child_process'

/** @typedef {'A'|'D'|'M'|'T'} Status */
/** @typedef {{ status: Status, path: string }} Change */
/** @typedef {{ base: string|null, head: string, source: 'event'|'merge-base'|'no-base' }} Range */

// The hash of the empty tree. Fixed by git's object format, identical in every
// repository — not something this repo generates, so there is nothing to compute.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

function git(args) {
  // 64 MiB, generously sized for a pull request's worth of `--name-status`
  // output. Left untested against its exact arithmetic: proving a particular
  // multiple wrong would mean committing a diff of that size to a throwaway
  // repository inside a test, which is a worse trade than the coverage buys.
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

/**
 * The two ends of the diff.
 * In CI they come from the pull request event; locally, from the merge base.
 *
 * @param {{ base?: string, head?: string, defaultBranch?: string }} [opts]
 * @returns {Range}
 */
export function resolveRange(opts = {}) {
  const base = opts.base ?? process.env.AGENTIC_BASE_SHA
  const head = opts.head ?? process.env.AGENTIC_HEAD_SHA

  if (base && head) return { base, head, source: 'event' }

  const branch = opts.defaultBranch ?? 'main'
  const currentHead = git(['rev-parse', 'HEAD']).trim()

  try {
    return { base: git(['merge-base', branch, 'HEAD']).trim(), head: currentHead, source: 'merge-base' }
  } catch {
    // Fresh repository, or the default branch does not exist yet: everything counts as new.
    return { base: null, head: currentHead, source: 'no-base' }
  }
}

/**
 * The changes in the range, with their status.
 *
 * `--no-renames` is deliberate. Without it, a file created from another one is
 * reported as a rename and disappears from the added-files filter. What coupling
 * rules care about is whether the PATH is new, not where its bytes came from.
 *
 * No base (see `resolveRange`) means "every path in `head` is new", so this
 * diffs against the empty tree rather than passing `--root`: `git diff` has no
 * such flag (that is a `git log`/`diff-tree` option), and silently ignoring it
 * turned this into `git diff head` — the *working tree* against `head`, i.e.
 * uncommitted local edits, not "everything HEAD introduces". On a clean tree
 * that reports zero changes, which is the false-green this fix closes: every
 * path in `head` must come back with status `A`, matching what `added()` and
 * the "everything counts as new" comment above actually promise.
 *
 * @param {Range} range
 * @returns {Change[]}
 */
export function changedFiles(range) {
  const args = ['diff', '--no-renames', '--name-status', '-z']
  if (range.base) args.push(`${range.base}...${range.head}`)
  else args.push(EMPTY_TREE, range.head)

  /** @type {Change[]} */
  const changes = []
  const fields = git(args).split('\0').filter(Boolean)

  // `R`/`C` (rename/copy) statuses, and the second path that comes with them,
  // are impossible here: `--no-renames` is always passed above and copy
  // detection is never requested (that needs its own `-C`/`--find-copies`
  // flag), so every status this call can produce carries exactly one path.
  // A branch to consume a second path that can never arrive is not a safety
  // net, it is untested code pretending to be one.
  for (let i = 0; i < fields.length; i++) {
    const status = /** @type {Status} */ (fields[i][0])
    changes.push({ status, path: fields[++i] })
  }
  return changes
}

/** Every path the range touches, deletions included. */
export const touched = (changes) => changes.map((c) => c.path)

/**
 * Paths that still exist after the change.
 *
 * A `changed` requirement asks for a change *in* a file, and deleting it is not
 * that: without this, the cheapest way to satisfy "document what you did" is to
 * delete the document. Deleting a whole module together with its contract is
 * the legitimate case, and it is rare enough to be waived deliberately rather
 * than allowed silently.
 */
export const present = (changes) => changes.filter((c) => c.status !== 'D').map((c) => c.path)

/** Paths this range ADDS. Modifying an existing file does not count. */
export const added = (changes) => changes.filter((c) => c.status === 'A').map((c) => c.path)
