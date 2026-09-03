import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadManifest, parseManifest, validateRules } from './manifest.mjs'

// Fixture manifests are YAML text built inline, or written under a throwaway
// directory in os.tmpdir() when a test needs to exercise the file-reading
// half of the loader — never committed to this repository.

/** All the `problems` from parsing `raw`, each one named and blocking. */
function problemsFor(raw) {
  const { problems } = parseManifest(raw)
  assert.ok(
    problems.every((p) => typeof p.message === 'string' && p.message.length > 0),
    'a problem with no message tells an agent nothing about what to change',
  )
  return problems
}

test('INV-manifest-01 a rule with no id is rejected by name, not silently ignored', () => {
  const problems = problemsFor(`
rules:
  - when: ["src/**"]
    require: [{ kind: label, name: reviewed }]
`)
  assert.ok(problems.some((p) => /missing "id"/.test(p.message)))
})

test('INV-manifest-02 a "when" written as a string is rejected instead of iterated character by character', () => {
  // matchList (lib/glob.mjs) would otherwise treat a bare string as a list of
  // one-character patterns, matching almost everything while catching nothing
  // the rule's author actually meant.
  const problems = problemsFor(`
rules:
  - id: string-when
    when: "src/*"
    require: [{ kind: label, name: reviewed }]
`)
  assert.ok(problems.some((p) => p.ruleId === 'string-when' && /"when" must be a list/.test(p.message)))
})

test('INV-manifest-03 a "require" that is not a list is rejected', () => {
  const problems = problemsFor(`
rules:
  - id: bad-require
    when: ["src/**"]
    require: { kind: label, name: reviewed }
`)
  assert.ok(problems.some((p) => p.ruleId === 'bad-require' && /"require" must be a list/.test(p.message)))
})

test('INV-manifest-04 an unknown key on a rule is named, not swallowed', () => {
  const problems = problemsFor(`
rules:
  - id: typo-rule
    whenn: ["src/**"]
    when: ["src/**"]
    require: [{ kind: label, name: reviewed }]
`)
  assert.ok(problems.some((p) => p.ruleId === 'typo-rule' && /unknown key "whenn"/.test(p.message)))
})

test('INV-manifest-05 an unknown requirement "kind" is named, with the rule and index that carries it', () => {
  const problems = problemsFor(`
rules:
  - id: bad-kind
    when: ["src/**"]
    require: [{ kind: wizardry }]
`)
  assert.ok(problems.some((p) => p.ruleId === 'bad-kind' && /require\[0\].*"kind" must be one of/.test(p.message)))
})

test('INV-manifest-06 kind "command" without "run" is rejected', () => {
  const problems = problemsFor(`
rules:
  - id: no-run
    when: ["src/**"]
    require: [{ kind: command }]
`)
  assert.ok(problems.some((p) => p.ruleId === 'no-run' && /kind "command" needs "run"/.test(p.message)))
})

test('INV-manifest-07 kind "label" without "name" is rejected', () => {
  const problems = problemsFor(`
rules:
  - id: no-name
    when: ["src/**"]
    require: [{ kind: label }]
`)
  assert.ok(problems.some((p) => p.ruleId === 'no-name' && /kind "label" needs "name"/.test(p.message)))
})

test('INV-manifest-08 kind "changed" whose "paths" is not a list is rejected', () => {
  const problems = problemsFor(`
rules:
  - id: paths-not-list
    when: ["src/**"]
    require: [{ kind: changed, paths: "src/CLAUDE.md" }]
`)
  assert.ok(problems.some((p) => p.ruleId === 'paths-not-list' && /needs "paths" as a list/.test(p.message)))
})

test('INV-manifest-09 an extra key not used by a requirement\'s kind is named', () => {
  // `paths` belongs to "added"/"changed", not "command" — a likely copy-paste
  // leftover from a different requirement.
  const problems = problemsFor(`
rules:
  - id: stray-key
    when: ["src/**"]
    require: [{ kind: command, run: "npm test", paths: ["src/**"] }]
`)
  assert.ok(problems.some((p) => p.ruleId === 'stray-key' && /unknown key "paths" for kind "command"/.test(p.message)))
})

test('INV-manifest-10 a "when: []" rule is rejected as a rule that can never fire', () => {
  const problems = problemsFor(`
rules:
  - id: never-fires-empty
    when: []
    require: [{ kind: label, name: reviewed }]
`)
  assert.ok(problems.some((p) => p.ruleId === 'never-fires-empty' && /can never fire/.test(p.message)))
})

test('INV-manifest-11 a "when" made entirely of negations is rejected as a rule that can never fire', () => {
  const problems = problemsFor(`
rules:
  - id: never-fires-negated
    when: ["!**", "!src/**"]
    require: [{ kind: label, name: reviewed }]
`)
  assert.ok(problems.some((p) => p.ruleId === 'never-fires-negated' && /can never fire/.test(p.message)))
})

test('INV-manifest-12 "paths: []" on an added requirement is rejected as impossible to satisfy', () => {
  const problems = problemsFor(`
rules:
  - id: impossible-added
    when: ["src/**"]
    require: [{ kind: added, paths: [] }]
`)
  assert.ok(problems.some((p) => p.ruleId === 'impossible-added' && /kind "added" has "paths: \[\]"/.test(p.message)))
})

test('INV-manifest-13 "paths: []" on a changed requirement is rejected as impossible to satisfy', () => {
  const problems = problemsFor(`
rules:
  - id: impossible-changed
    when: ["src/**"]
    require: [{ kind: changed, paths: [] }]
`)
  assert.ok(problems.some((p) => p.ruleId === 'impossible-changed' && /kind "changed" has "paths: \[\]"/.test(p.message)))
})

test('INV-manifest-14 two rules sharing an id are rejected as duplicates', () => {
  const problems = problemsFor(`
rules:
  - id: dup
    when: ["src/**"]
    require: [{ kind: label, name: reviewed }]
  - id: dup
    when: ["docs/**"]
    require: [{ kind: label, name: reviewed }]
`)
  assert.ok(problems.some((p) => p.ruleId === 'dup' && /duplicate rule id/.test(p.message)))
})

test('INV-manifest-15 a "min" of zero is rejected, not silently treated as always-satisfied', () => {
  const problems = problemsFor(`
rules:
  - id: zero-min
    when: ["src/**"]
    require: [{ kind: added, paths: ["src/{module}/tests/**"], min: 0 }]
`)
  assert.ok(problems.some((p) => p.ruleId === 'zero-min' && /"min" must be a positive integer/.test(p.message)))
})

test('INV-manifest-16 a "min" that is not an integer is rejected', () => {
  const problems = problemsFor(`
rules:
  - id: fractional-min
    when: ["src/**"]
    require: [{ kind: changed, paths: ["src/**"], min: 1.5 }]
`)
  assert.ok(problems.some((p) => p.ruleId === 'fractional-min' && /"min" must be a positive integer/.test(p.message)))
})

test('INV-manifest-17 an empty "require" list is rejected as a rule that demands nothing', () => {
  const problems = problemsFor(`
rules:
  - id: toothless
    when: ["src/**"]
    require: []
`)
  assert.ok(problems.some((p) => p.ruleId === 'toothless' && /"require" is empty/.test(p.message)))
})

test('INV-manifest-18 a well-formed manifest produces no problems at all', () => {
  const { rules, problems } = parseManifest(`
rules:
  - id: module-contract
    when: ["src/{module}/**", "!src/{module}/CLAUDE.md"]
    require: [{ kind: changed, paths: ["src/{module}/CLAUDE.md"] }]
    why: keep the contract honest
  - id: schema-migration
    when: ["src/db/schema.sql"]
    require:
      - { kind: command, run: "npm run migrate:check" }
      - { kind: added, paths: ["migrations/**"], min: 1 }
`)
  assert.equal(problems.length, 0)
  assert.equal(rules.length, 2)
})

test('INV-manifest-19 a manifest with zero rules is rejected as declaring nothing', () => {
  const { rules, problems } = parseManifest('rules: []\n')
  assert.deepEqual(rules, [])
  assert.ok(problems.some((p) => p.ruleId === null && /no rules declared/.test(p.message)))
})

test('INV-manifest-20 a missing manifest file is reported by name instead of throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'manifest-test-'))
  try {
    const { rules, problems } = loadManifest(join(dir, 'does-not-exist.yaml'))
    assert.deepEqual(rules, [])
    assert.ok(problems.some((p) => p.ruleId === null && /not found/.test(p.message)))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('INV-manifest-21 loadManifest reads and validates a real file from disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'manifest-test-'))
  try {
    const file = join(dir, 'coupling.yaml')
    writeFileSync(
      file,
      `
rules:
  - id: on-disk
    when: ["src/**"]
    require: [{ kind: label, name: reviewed }]
`,
    )
    const { rules, problems } = loadManifest(file)
    assert.equal(problems.length, 0)
    assert.equal(rules.length, 1)
    assert.equal(rules[0].id, 'on-disk')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('INV-manifest-22 validateRules works directly on an already-parsed array, with no YAML involved', () => {
  const problems = validateRules([{ id: 'bare', when: [], require: [{ kind: 'label', name: 'reviewed' }] }])
  assert.ok(problems.some((p) => p.ruleId === 'bare' && /can never fire/.test(p.message)))
})

test('INV-manifest-23 a requirement entry that is not an object is reported by name, not a crash', () => {
  // `req?.kind` guards this: without it, a requirement written as `null` (a
  // stray "-" in a YAML list, or a typo'd requirement) would throw instead of
  // reporting a problem -- exactly the crash this file's own docstring says a
  // validation failure must never become.
  const problems = validateRules([{ id: 'r', when: ['a'], require: [null] }])
  assert.ok(problems.some((p) => p.ruleId === 'r' && /require\[0\].*"kind" must be one of/.test(p.message)))
})

test('INV-manifest-24 a rule entry that is not an object is reported for every check, not a crash', () => {
  const problems = validateRules([null])
  assert.ok(problems.some((p) => /missing "id"/.test(p.message)))
  assert.ok(problems.some((p) => /"when" must be a list of patterns, got undefined/.test(p.message)))
  assert.ok(problems.some((p) => /"require" must be a list of requirements, got undefined/.test(p.message)))
})

test('INV-manifest-25 an unknown "kind" names every kind it could have been, comma-separated', () => {
  const problems = validateRules([{ id: 'bad-kind', when: ['a'], require: [{ kind: 'wizardry' }] }])
  assert.ok(problems.some((p) => /command, added, changed, label/.test(p.message)))
})

test('INV-manifest-26 an empty YAML document is reported as declaring no rules, not a crash', () => {
  // `parse("")` returns `null`, not `{ rules: [] }` -- `doc?.rules` is what
  // keeps this from reading as "no rules declared" instead of throwing on
  // `null.rules`.
  const { rules, problems } = parseManifest('')
  assert.deepEqual(rules, [])
  assert.ok(problems.some((p) => p.ruleId === null && /no rules declared/.test(p.message)))
})

test('INV-manifest-27 a YAML syntax error is reported by name and position, not thrown', () => {
  const { rules, problems } = parseManifest('rules:\n  - id: x\n    when: ["a"\n')
  assert.deepEqual(rules, [])
  assert.equal(problems.length, 1)
  assert.match(problems[0].message, /could not be parsed as YAML/)
  // The position is what lets an agent jump straight to the mistake instead
  // of re-reading the whole file.
  assert.match(problems[0].message, /line \d/i)
})

test('INV-manifest-28 "fix" is accepted on any requirement kind, never flagged as an unknown key', () => {
  const problems = validateRules([
    { id: 'with-fix', when: ['a'], require: [{ kind: 'label', name: 'reviewed', fix: 'add the label' }] },
  ])
  assert.equal(problems.length, 0)
})

test('INV-manifest-29 "min" and "rejectWhitespaceOnly" are accepted on a "changed" requirement, never flagged as unknown', () => {
  const problems = validateRules([
    { id: 'ws', when: ['a'], require: [{ kind: 'changed', paths: ['b'], min: 1, rejectWhitespaceOnly: true }] },
  ])
  assert.equal(problems.length, 0)
})

test('INV-manifest-30 a "when" list with no string pattern at all can never fire, even if every entry is truthy', () => {
  // Only a string entry can ever be a positive pattern; anything else (a stray
  // number, an object) can neither match a path nor be recognised as a
  // negation, so a "when" made only of such entries is exactly as inert as an
  // empty one.
  const problems = validateRules([{ id: 'no-strings', when: [123], require: [{ kind: 'label', name: 'x' }] }])
  assert.ok(problems.some((p) => p.ruleId === 'no-strings' && /can never fire/.test(p.message)))
})

test('INV-manifest-31 a rule with no id is still labelled in its other problems, not left blank', () => {
  const problems = validateRules([{ when: 'not-a-list', require: [] }])
  assert.ok(
    problems.some((p) => /^\(unnamed rule\): "when" must be a list/.test(p.message)),
    'every problem for an unnamed rule must still say "(unnamed rule)", not stand with nothing before the colon',
  )
})
