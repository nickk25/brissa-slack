/**
 * Loading and validating the coupling manifest.
 *
 * This is the single place that reads `coupling.yaml`, parses it and checks
 * its shape. `gate.mjs` and `contracts.mjs` both read the same file and both
 * turn it into rules that get run — a malformed manifest is exactly as
 * dangerous to one as to the other, so there must be exactly one place that
 * decides what "malformed" means, and neither tool may see a rule that has
 * not passed through here. `when: "src/*"` written as a string instead of a
 * list is valid YAML but the wrong shape: a string iterates character by
 * character, so a generator that calls `r.when.filter(...)` on it directly
 * throws `TypeError: r.when.filter is not a function` instead of ever naming
 * the rule or the mistake, and a caller that instead just iterates it gets a
 * rule that fires on unrelated paths while staying silent on the one it meant
 * to catch.
 *
 * A validation failure is data, not an exception: callers collect a list of
 * `ManifestProblem`s and decide for themselves how to report and exit, the
 * same way `gate.mjs`'s violations already work. The checks below extend the
 * same shape-checking idea to rules that parse and run without error but can
 * never do anything: those are worse than a crash, because they look like a
 * working rule.
 */

import { readFileSync } from 'node:fs'
import { parse } from 'yaml'

const KNOWN_KINDS = new Set(['command', 'added', 'changed', 'label'])
const RULE_KEYS = new Set(['id', 'when', 'require', 'why'])
const COMMON_REQ_KEYS = new Set(['kind', 'fix'])
// Which extra keys each requirement kind actually uses. Anything outside this
// set is either a typo (a rule author meant `path` and wrote `paths` on the
// wrong kind) or a leftover from copy-pasting a different requirement, and
// both deserve a name, not silence.
const KIND_KEYS = {
  command: new Set(['run']),
  added: new Set(['paths', 'min']),
  changed: new Set(['paths', 'min', 'rejectWhitespaceOnly']),
  label: new Set(['name']),
}

/**
 * @typedef {Object} ManifestProblem
 * @property {string|null} ruleId  The offending rule's id, or `null` when the
 *   problem is about the manifest as a whole (the file is missing, or it has
 *   no rules) rather than about one rule in it.
 * @property {string} message  What is wrong, in the voice the rest of this
 *   repository's output uses: names the rule, names the problem, and where
 *   there is a clear fix, says what to do.
 */

/**
 * Could this `when` list ever match a real path?
 *
 * A pattern list is evaluated by `matchList` (lib/glob.mjs) as "included by
 * some positive pattern, and excluded by none" — so a list with no positive
 * pattern at all (empty, or every entry a negation) can never include
 * anything. That rule can never fire, which is not a gate that is merely
 * lenient; it is a promise the manifest makes that nothing behind it can ever
 * keep.
 * @param {any[]} when
 * @returns {boolean}
 */
function canFire(when) {
  return when.some((w) => typeof w === 'string' && !w.startsWith('!'))
}

/**
 * Validate an already-parsed array of rules.
 *
 * Two different kinds of problem live here, and both block:
 *
 *  - Malformed data: a missing "id", a "when" that isn't a list, a "kind"
 *    that doesn't exist, a duplicate rule id, a "min" that isn't a positive
 *    integer. Left alone, these either crash a caller outright or make it
 *    silently do the wrong thing (a duplicate id makes a violation report and
 *    a `--plan` output impossible to tell apart; a `min` of 0 makes a
 *    requirement pass no matter what the change set contains).
 *  - Inert rules: a "when" that can never fire, an `added`/`changed`
 *    requirement whose "paths" is `[]` (nothing can ever match it, so the
 *    requirement is impossible rather than merely strict), a "require" list
 *    that is empty (the rule fires and asks for nothing).
 *
 * Both were made errors rather than warnings. A warning that never blocks
 * anything is exactly the kind of theatre this repository's own docs warn
 * against for the `changed` requirement kind — it would sit in the manifest
 * looking enforced while doing nothing, indistinguishable from a rule that
 * works until someone reads it by hand. A rule set is a set of promises, and
 * these are all promises that cannot be kept: a rule that can never fire, a
 * requirement nothing can satisfy, an id that no longer uniquely names
 * anything. None of that is a matter of taste to be flagged and left for
 * later; it belongs in the same bucket as the pre-existing shape checks.
 *
 * @param {any[]} rules
 * @returns {ManifestProblem[]}
 */
export function validateRules(rules) {
  const problems = []
  const seenIds = new Set()

  for (const rule of rules) {
    const label = rule?.id ?? '(unnamed rule)'
    const err = (message) => problems.push({ ruleId: rule?.id ?? null, message: `${label}: ${message}` })

    if (!rule?.id) {
      err('missing "id"')
    } else if (seenIds.has(rule.id)) {
      err('duplicate rule id — every id must be unique, or a violation and a --plan entry for one rule cannot be told apart from the other')
    } else {
      seenIds.add(rule.id)
    }

    if (!Array.isArray(rule?.when)) {
      err(`"when" must be a list of patterns, got ${typeof rule?.when}`)
    } else if (!canFire(rule.when)) {
      err('"when" can never fire — it is empty, or every entry is a negation ("!..."), so no path can ever match it. Add a positive pattern, or delete the rule')
    }

    if (!Array.isArray(rule?.require)) {
      err(`"require" must be a list of requirements, got ${typeof rule?.require}`)
    } else if (rule.require.length === 0) {
      err('"require" is empty — a rule that fires and demands nothing is indistinguishable from no rule at all. Add a requirement, or delete the rule')
    }

    for (const key of Object.keys(rule ?? {})) {
      if (!RULE_KEYS.has(key)) err(`unknown key "${key}"`)
    }

    if (!Array.isArray(rule?.require)) continue
    // `rule` is guaranteed a real object below: `Array.isArray(rule?.require)`
    // just returned true, and that is false for every null/undefined `rule`.
    rule.require.forEach((req, i) => {
      const where = `${label}, require[${i}]`
      const reqErr = (message) => problems.push({ ruleId: rule.id ?? null, message: `${where}: ${message}` })

      if (!KNOWN_KINDS.has(req?.kind)) {
        reqErr(`"kind" must be one of ${[...KNOWN_KINDS].join(', ')}, got ${JSON.stringify(req?.kind)}`)
        return // Nothing else below is checkable without knowing the kind.
      }
      if (req.kind === 'command' && !req.run) reqErr('kind "command" needs "run"')
      if (req.kind === 'label' && !req.name) reqErr('kind "label" needs "name"')

      if (req.kind === 'added' || req.kind === 'changed') {
        if (!Array.isArray(req.paths)) {
          reqErr(`kind "${req.kind}" needs "paths" as a list`)
        } else if (req.paths.length === 0) {
          reqErr(`kind "${req.kind}" has "paths: []" — with nothing to match, this requirement can never be satisfied, no matter what the change set contains. Add a path pattern, or delete the requirement`)
        }
        if ('min' in req && !(Number.isInteger(req.min) && req.min > 0)) {
          reqErr(`"min" must be a positive integer, got ${JSON.stringify(req.min)}`)
        }
      }

      const allowed = new Set([...COMMON_REQ_KEYS, ...KIND_KEYS[req.kind]])
      for (const key of Object.keys(req)) {
        if (!allowed.has(key)) reqErr(`unknown key "${key}" for kind "${req.kind}"`)
      }
    })
  }

  return problems
}

/**
 * Parse a manifest's YAML text and validate the rules it declares.
 *
 * Split from {@link loadManifest} so a test — or any other caller that
 * already has the text, from a fixture string or otherwise — can exercise
 * validation without touching a filesystem at all.
 *
 * @param {string} raw
 * @returns {{ rules: any[], problems: ManifestProblem[] }}
 */
export function parseManifest(raw) {
  // A YAML syntax error is a manifest problem like any other, and an agent
  // reading a raw parser stack learns nothing about which file to open.
  let doc
  try {
    doc = parse(raw)
  } catch (err) {
    const firstLine = String(err.message).split('\n')[0]
    return { rules: [], problems: [{ ruleId: null, message: `could not be parsed as YAML: ${firstLine}` }] }
  }
  const rules = doc?.rules
  if (!Array.isArray(rules) || rules.length === 0) {
    return { rules: [], problems: [{ ruleId: null, message: 'has no rules declared' }] }
  }
  return { rules, problems: validateRules(rules) }
}

/**
 * Read the manifest file at `path`, parse it, and validate it.
 *
 * The one function `gate.mjs` and `contracts.mjs` both call before touching a
 * rule. Neither tool reads the file itself any more, so neither can end up
 * consuming a manifest that has not passed through {@link validateRules}.
 *
 * @param {string} path
 * @returns {{ rules: any[], problems: ManifestProblem[] }}
 */
export function loadManifest(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return { rules: [], problems: [{ ruleId: null, message: 'not found — this repository declares no coupling rules yet' }] }
  }
  return parseManifest(raw)
}
