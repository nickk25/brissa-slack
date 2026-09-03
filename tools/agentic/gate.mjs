#!/usr/bin/env node
/**
 * The gate.
 *
 * Its output is the primary interface of this repository. Almost every reader is
 * an agent, and a failure that says "coupling failed" costs it a whole cycle, so
 * every violation names the rule, what triggered it, what is missing, and what to
 * do next. That is not decoration — it is the difference between a gate that
 * teaches and a gate that blocks.
 *
 *   gate                     evaluate the current change set
 *   gate --plan a.ts b.ts    which rules those paths would fire, running nothing
 *   gate --json              the same result as data, for anything downstream
 */

import { relative, resolve, sep } from 'node:path'
import { changedFiles, resolveRange, touched } from './lib/changed.mjs'
import { evaluate, planFor } from './lib/coupling.mjs'
import { loadManifest } from './lib/manifest.mjs'

const MANIFEST = process.env.AGENTIC_MANIFEST ?? 'coupling.yaml'

const c = process.stdout.isTTY
  ? { red: '\x1b[31m', green: '\x1b[32m', dim: '\x1b[2m', bold: '\x1b[1m', off: '\x1b[0m' }
  : { red: '', green: '', dim: '', bold: '', off: '' }

/**
 * Load and validate the manifest, or exit 2 explaining why not.
 *
 * `lib/manifest.mjs` is the only thing that reads and checks the file;
 * `contracts.mjs` goes through the same function, so neither tool can end up
 * evaluating a rule the other would have rejected.
 */
function loadRules() {
  const { rules, problems } = loadManifest(MANIFEST)
  // Every problem a manifest can have is blocking; there is no advisory tier,
  // because a warning that never blocks is the theatre this repository refuses.
  const errors = problems
  if (errors.length) {
    console.error(`${c.red}${c.bold}${MANIFEST} problem${errors.length > 1 ? 's' : ''}${c.off}\n`)
    for (const p of errors) console.error(`  ${c.red}✗${c.off} ${p.ruleId ? p.message : `${MANIFEST} ${p.message}`}`)
    process.exit(2)
  }
  return rules
}

/**
 * Repo-relative, forward-slash form, matching what patterns in the manifest
 * are written against. `--plan` takes paths from a human or agent typing a
 * command line, and `./coupling.yaml`, `coupling.yaml/` and an absolute path
 * inside the repo all name the same file as `coupling.yaml` — but only the
 * last one matches a pattern literally, so the other two silently fired
 * nothing. Assumes gate.mjs runs from the repository root, same as every
 * other path in this file (`MANIFEST` itself is read relative to cwd).
 * @param {string} p
 */
function normalizePath(p) {
  const rel = relative(process.cwd(), resolve(process.cwd(), p))
  return rel.split(sep).join('/').replace(/\/+$/, '')
}

const describe = (bindings) =>
  Object.keys(bindings).length ? ` ${c.dim}(${Object.entries(bindings).map(([k, v]) => `${k}=${v}`).join(', ')})${c.off}` : ''

function reportViolations(violations) {
  console.error(`\n${c.red}${c.bold}${violations.length} coupling violation${violations.length > 1 ? 's' : ''}${c.off}\n`)
  for (const v of violations) {
    console.error(`${c.red}✗${c.off} ${c.bold}${v.ruleId}${c.off}${describe(v.bindings)}`)
    console.error(`  ${c.dim}triggered by${c.off}  ${v.triggeredBy.join(', ')}`)
    console.error(`  ${c.dim}required${c.off}      ${v.required}`)
    if (v.why) console.error(`  ${c.dim}why${c.off}           ${v.why}`)
    if (v.fix) console.error(`  ${c.dim}fix${c.off}           ${v.fix}`)
    if (v.detail) console.error(v.detail.split('\n').map((l) => `                ${c.dim}${l}${c.off}`).join('\n'))
    console.error('')
  }
}

function main() {
  const argv = process.argv.slice(2)
  const json = argv.includes('--json')
  const planAt = argv.indexOf('--plan')
  const rules = loadRules()

  if (planAt !== -1) {
    const paths = argv.slice(planAt + 1).filter((a) => !a.startsWith('--')).map(normalizePath)
    if (!paths.length) {
      console.error('gate --plan needs the paths you intend to touch.')
      process.exit(2)
    }
    const plan = planFor(rules, paths)
    if (json) return console.log(JSON.stringify({ plan }, null, 2))

    if (!plan.length) return console.log(`${c.green}No rules fire for those paths.${c.off}`)
    console.log(`\n${c.bold}Touching those paths will require:${c.off}\n`)
    for (const p of plan) {
      console.log(`${c.bold}${p.ruleId}${c.off}${describe(p.bindings)}`)
      for (const o of p.obligations) console.log(`  · ${o}`)
      console.log('')
    }
    return
  }

  const range = resolveRange()
  const changes = changedFiles(range)
  const allowEmpty = argv.includes('--allow-empty')

  // Zero files changed means zero rules could possibly have fired. Reporting
  // success anyway is the exact false reassurance this repository exists to
  // prevent: a gate that measured nothing is not the same as a gate that
  // passed. `main` and a clean tree both land here via the merge-base fallback
  // in resolveRange, so this check must not assume a non-empty diff.
  if (!changes.length && !allowEmpty) {
    const rangeDesc = `${range.base ?? '(none)'}...${range.head} (${range.source})`
    if (json) {
      console.log(JSON.stringify({ range, changed: 0, rulesFired: 0, violations: [], error: 'empty-change-set' }, null, 2))
    } else {
      console.error(`${c.red}${c.bold}✗ nothing was measured${c.off}`)
      console.error(`  ${c.dim}range${c.off}  ${rangeDesc}`)
      console.error(
        `  ${c.dim}A green gate that evaluated zero files is worse than no gate at all. Pass --allow-empty if that is genuinely expected here.${c.off}`,
      )
    }
    process.exit(1)
  }

  const labels = (process.env.AGENTIC_PR_LABELS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const violations = evaluate({ rules, changes, range, labels })
  // How many rules actually had something to say about this change set, so a
  // green result carries its own evidence instead of asking the reader to
  // trust it. Reuses `planFor`, the same "what would fire" computation `--plan`
  // reports, over the paths this range actually touched.
  const rulesFired = new Set(planFor(rules, touched(changes)).map((p) => p.ruleId)).size

  if (json) {
    console.log(JSON.stringify({ range, changed: changes.length, rulesFired, violations }, null, 2))
    process.exit(violations.length ? 1 : 0)
  }

  if (!violations.length) {
    console.log(
      changes.length
        ? `${c.green}✓${c.off} ${changes.length} file${changes.length === 1 ? '' : 's'} changed, ${rulesFired} rule${rulesFired === 1 ? '' : 's'} fired, every coupling rule satisfied.`
        // Nothing was measured and that was explicitly allowed. Saying "every
        // rule satisfied" here would be the same false green wearing a flag.
        : `${c.green}✓${c.off} no files changed; nothing to check (--allow-empty).`,
    )
    return
  }

  reportViolations(violations)
  process.exit(1)
}

main()
