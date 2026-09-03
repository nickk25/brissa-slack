import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { changedFiles, resolveRange } from './changed.mjs'
import { evaluate, planFor } from './coupling.mjs'

const range = { base: null, head: 'HEAD', source: 'no-base' }
const change = (path, status = 'M') => ({ status, path })

const GATE = fileURLToPath(new URL('../gate.mjs', import.meta.url))
// A malicious capture only proves anything against a real git history: the
// bindings under test have to come from `matchList`, not be typed by hand,
// or the test would just be checking that a string equals itself. Every test
// below that needs one builds a throwaway repository under os.tmpdir() and
// tears it down when it is done, never against fixtures committed here.
function makeRepo() {
  // Resolved with realpathSync: on macOS os.tmpdir() is a symlink (/var ->
  // /private/var), and a subprocess's own process.cwd() reports the resolved
  // path -- comparing an unresolved root against that would make an absolute
  // path built from it look like it lives outside the repo the gate sees.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'coupling-test-')))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  return { root, git }
}
// Strip any CI-style range override from the environment this test itself
// runs under, so a gate.mjs subprocess resolves its range from the fixture
// repo's own history rather than accidentally inheriting the real one.
const GATE_ENV = { ...process.env, AGENTIC_BASE_SHA: '', AGENTIC_HEAD_SHA: '', AGENTIC_PR_LABELS: '' }

// `resolveRange` consults AGENTIC_BASE_SHA / AGENTIC_HEAD_SHA before it looks at
// git, so a test about the fallback paths has to run with them unset. CI sets
// both for the gate step; without this the test exercises the event path there
// and the fallback path locally.
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

const moduleContract = {
  id: 'module-contract',
  when: ['src/{module}/**', '!src/{module}/CLAUDE.md'],
  require: [{ kind: 'changed', paths: ['src/{module}/CLAUDE.md'] }],
}

test('INV-coupling-01 a captured rule fans out once per module actually touched', () => {
  const violations = evaluate({
    rules: [moduleContract],
    changes: [change('src/core/plan.ts'), change('src/llm/client.ts')],
    range,
  })
  assert.equal(violations.length, 2)
  assert.deepEqual(violations.map((v) => v.bindings.module).sort(), ['core', 'llm'])
})

test('INV-coupling-02 a rule stays silent for modules the change set never touches', () => {
  const violations = evaluate({
    rules: [moduleContract],
    changes: [change('README.md')],
    range,
  })
  assert.equal(violations.length, 0)
})

test('INV-coupling-03 the capture is substituted into the requirement, per module', () => {
  const violations = evaluate({
    rules: [moduleContract],
    changes: [change('src/core/plan.ts'), change('src/core/CLAUDE.md')],
    range,
  })
  assert.equal(violations.length, 0, 'core satisfied its own contract, not some other module\'s')
})

test('INV-coupling-04 `added` refuses a modified file where a new one was required', () => {
  const rule = {
    id: 'schema-migration',
    when: ['db/schema.ts'],
    require: [{ kind: 'added', paths: ['db/migrations/*.sql'] }],
  }
  const modified = evaluate({
    rules: [rule],
    changes: [change('db/schema.ts'), change('db/migrations/001.sql', 'M')],
    range,
  })
  assert.equal(modified.length, 1, 'editing an old migration is not adding one')

  const created = evaluate({
    rules: [rule],
    changes: [change('db/schema.ts'), change('db/migrations/002.sql', 'A')],
    range,
  })
  assert.equal(created.length, 0)
})

test('INV-coupling-05 a label requirement reads the labels on the pull request', () => {
  const rule = {
    id: 'protected',
    when: ['coupling.yaml'],
    require: [{ kind: 'label', name: 'human-approved' }],
  }
  const changes = [change('coupling.yaml')]
  const violations = evaluate({ rules: [rule], changes, range, labels: [] })
  assert.equal(violations.length, 1)
  // What an agent needs is the rule id and the label it is missing — asserted
  // structurally (ruleId) and by content (required names the label), not by
  // pinning the sentence around them.
  assert.equal(violations[0].ruleId, 'protected')
  assert.match(violations[0].required, /human-approved/)
  assert.equal(evaluate({ rules: [rule], changes, range, labels: ['human-approved'] }).length, 0)
})

test('INV-coupling-06 plan mode never executes a command requirement', () => {
  // The whole value of `--plan` is that an agent can ask what a change will cost
  // before making it. Running the commands would make asking as expensive as doing.
  const rule = {
    id: 'boom',
    when: ['a.ts'],
    require: [{ kind: 'command', run: 'exit 1' }],
  }
  const violations = evaluate({ rules: [rule], changes: [change('a.ts')], range, plan: true })
  assert.equal(violations.length, 0)

  const plan = planFor([rule], ['a.ts'])
  assert.equal(plan.length, 1)
  assert.match(plan[0].obligations[0], /exit 1/)
})

test('INV-coupling-07 a failing command reports its own output, not just its exit code', () => {
  // An agent that only learns "the command failed" has to re-run it to find out
  // why, which costs a cycle. The tail of the output is the whole point.
  const violations = evaluate({
    rules: [{ id: 'noisy', when: ['a.ts'], require: [{ kind: 'command', run: 'echo "the actual reason" >&2; exit 1' }] }],
    changes: [change('a.ts')],
    range,
  })
  assert.equal(violations.length, 1)
  assert.match(violations[0].detail, /the actual reason/)
  // The command itself is the other half of "what to do about it" — an agent
  // told only "a command failed" still has to go find which one.
  assert.match(violations[0].required, /echo/)
})

test('INV-coupling-08 a hostile capture cannot execute anything through a command requirement', () => {
  const { root, git } = makeRepo()
  try {
    const marker = join(root, 'PWNED-command')
    const hostile = 'x`touch ' + marker + '`y'
    mkdirSync(join(root, 'src', hostile), { recursive: true })
    writeFileSync(join(root, 'src', hostile, 'f.ts'), 'x')
    git('add', '-A')
    git('commit', '-q', '-m', 'hostile module name')
    const head = git('rev-parse', 'HEAD').trim()

    const rule = {
      id: 'per-module-check',
      when: ['src/{module}/**'],
      require: [{ kind: 'command', run: 'echo module {module} checked' }],
    }
    const violations = evaluate({
      rules: [rule],
      changes: [{ status: 'A', path: `src/${hostile}/f.ts` }],
      range: { base: null, head, source: 'no-base' },
    })

    assert.equal(violations.length, 1, 'an unsafe capture must refuse the rule instead of running it')
    assert.match(violations[0].required, /safe to run in a shell command/)
    assert.match(violations[0].detail, /"module"/)
    assert.equal(existsSync(marker), false, 'the injected command must never have run')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('INV-coupling-09 a hostile path cannot execute anything through the whitespace probe', () => {
  const { root, git } = makeRepo()
  const cwd = process.cwd()
  try {
    // The marker is a bare name, not a path: `git diff` runs with the fixture
    // repo as its cwd (see the chdir below), so an injected `touch` with no
    // path of its own would land right there if it ran at all.
    const markerName = 'PWNED-whitespace'
    const marker = join(root, markerName)
    const hostile = 'x`touch ' + markerName + '`y.txt'
    writeFileSync(join(root, hostile), 'line one\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'add hostile file')
    const base = git('rev-parse', 'HEAD').trim()

    writeFileSync(join(root, hostile), 'line one  \n') // trailing whitespace only
    git('add', '-A')
    git('commit', '-q', '-m', 'whitespace-only edit')
    const head = git('rev-parse', 'HEAD').trim()

    const rule = {
      id: 'ws-rule',
      when: [hostile],
      require: [{ kind: 'changed', paths: [hostile], rejectWhitespaceOnly: true }],
    }
    // The whitespace probe shells out to `git diff`, relative to process.cwd() --
    // it must run against the fixture's own history, not this test's own repo.
    process.chdir(root)
    const violations = evaluate({
      rules: [rule],
      changes: [{ status: 'M', path: hostile }],
      range: { base, head, source: 'event' },
    })

    assert.equal(violations.length, 1, 'a whitespace-only edit is still not a real change, hostile filename or not')
    assert.equal(existsSync(marker), false, 'the injected command must never have run')
  } finally {
    process.chdir(cwd)
    rmSync(root, { recursive: true, force: true })
  }
})

test('INV-coupling-10 a whitespace-only edit does not satisfy `rejectWhitespaceOnly`', () => {
  const { root, git } = makeRepo()
  const cwd = process.cwd()
  try {
    writeFileSync(join(root, 'f.txt'), 'line one\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    const base = git('rev-parse', 'HEAD').trim()

    writeFileSync(join(root, 'f.txt'), 'line one   \n')
    git('add', '-A')
    git('commit', '-q', '-m', 'whitespace only')
    const head = git('rev-parse', 'HEAD').trim()

    const rule = { id: 'ws', when: ['f.txt'], require: [{ kind: 'changed', paths: ['f.txt'], rejectWhitespaceOnly: true }] }
    process.chdir(root)
    const violations = evaluate({ rules: [rule], changes: [change('f.txt')], range: { base, head, source: 'event' } })
    assert.equal(violations.length, 1, '--name-only lists the file regardless of -w; only a real content diff may satisfy this')
  } finally {
    process.chdir(cwd)
    rmSync(root, { recursive: true, force: true })
  }
})

test('INV-coupling-11 an edit with real content satisfies `rejectWhitespaceOnly`', () => {
  const { root, git } = makeRepo()
  const cwd = process.cwd()
  try {
    writeFileSync(join(root, 'f.txt'), 'line one\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    const base = git('rev-parse', 'HEAD').trim()

    writeFileSync(join(root, 'f.txt'), 'line one\nline two\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'real content')
    const head = git('rev-parse', 'HEAD').trim()

    const rule = { id: 'ws', when: ['f.txt'], require: [{ kind: 'changed', paths: ['f.txt'], rejectWhitespaceOnly: true }] }
    process.chdir(root)
    const violations = evaluate({ rules: [rule], changes: [change('f.txt')], range: { base, head, source: 'event' } })
    assert.equal(violations.length, 0, 'a real content change must satisfy the requirement')
  } finally {
    process.chdir(cwd)
    rmSync(root, { recursive: true, force: true })
  }
})

test('INV-coupling-12 an unbound capture in a required path is reported as a rule error, not a crash', () => {
  const rule = {
    id: 'typoed-capture',
    // "mod", not "module" -- a rule-authoring typo `when` itself never binds.
    when: ['src/{module}/**'],
    require: [{ kind: 'changed', paths: ['src/{mod}/CLAUDE.md'] }],
  }
  const violations = evaluate({ rules: [rule], changes: [change('src/core/plan.ts')], range })
  assert.equal(violations.length, 1, 'a rule referencing an unbound capture must be reported, not crash the whole gate')
  assert.match(violations[0].required, /well-formed rule/)
  assert.match(violations[0].detail, /unbound capture "mod"/)
})

test('INV-coupling-13 with no base, every path HEAD introduces counts as new, not the working tree against HEAD', () => {
  const { root, git } = makeRepo()
  const cwd = process.cwd()
  try {
    writeFileSync(join(root, 'a.txt'), 'a')
    writeFileSync(join(root, 'b.txt'), 'b')
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    process.chdir(root)

    // No branch by this name exists, so `git merge-base` fails and resolveRange
    // must fall back to its no-base path -- the one this test exercises.
    const noBase = withoutEventEnv(() => resolveRange({ defaultBranch: 'no-such-branch' }))
    assert.equal(noBase.base, null)

    const changes = changedFiles(noBase)
    // A clean working tree would report zero changes here if this diffed the
    // working tree against HEAD instead of the empty tree against HEAD.
    // "No base" must mean "everything in HEAD is new", not "nothing changed
    // locally".
    assert.equal(changes.length, 2)
    assert.ok(changes.every((c) => c.status === 'A'))
  } finally {
    process.chdir(cwd)
    rmSync(root, { recursive: true, force: true })
  }
})

test('INV-coupling-14 gate refuses to report success when the change set is empty, and --allow-empty opts back in', () => {
  const { root, git } = makeRepo()
  try {
    writeFileSync(
      join(root, 'coupling.yaml'),
      'version: 1\nrules:\n  - id: noop\n    when: ["never/touched.txt"]\n    require:\n      - kind: label\n        name: whatever\n',
    )
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    // On a fresh branch with a clean tree, merge-base(main, HEAD) is HEAD
    // itself, so the change set is genuinely empty -- reproduced here without
    // any uncommitted state.

    assert.throws(
      () => execFileSync('node', [GATE], { cwd: root, encoding: 'utf8', env: GATE_ENV }),
      (err) => {
        assert.equal(err.status, 1, 'an empty change set must not exit 0')
        assert.match(err.stderr, /nothing was measured/i)
        assert.match(err.stderr, /--allow-empty/)
        return true
      },
      'a gate that measured zero files must not report success',
    )

    const out = execFileSync('node', [GATE, '--allow-empty'], { cwd: root, encoding: 'utf8', env: GATE_ENV })
    assert.match(out, /nothing to check/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('INV-coupling-15 gate --plan normalises a "./" prefix, a trailing slash, and an absolute path to the same result', () => {
  // realpathSync: see the comment in makeRepo() -- an absolute path built
  // from the unresolved tmpdir would not match the subprocess's own cwd.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'coupling-test-')))
  try {
    writeFileSync(
      join(root, 'coupling.yaml'),
      'version: 1\nrules:\n  - id: spec-rule\n    when: ["docs/spec.md"]\n    require:\n      - kind: label\n        name: reviewed\n',
    )
    const planFor_ = (arg) =>
      JSON.parse(execFileSync('node', [GATE, '--plan', '--json', arg], { cwd: root, encoding: 'utf8', env: GATE_ENV }))

    const bare = planFor_('docs/spec.md')
    assert.equal(bare.plan.length, 1, 'the bare relative path is the baseline: the rule must fire')

    for (const arg of ['./docs/spec.md', 'docs/spec.md/', join(root, 'docs/spec.md')]) {
      assert.deepEqual(planFor_(arg), bare, `"${arg}" must normalise to the same result as the bare relative path`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('INV-coupling-16 gate rejects a malformed manifest before evaluating anything, naming the rule and the problem', () => {
  const root = mkdtempSync(join(tmpdir(), 'coupling-test-'))
  try {
    // `when` written as a string instead of a list: `matchList` would otherwise
    // iterate it one character at a time rather than refusing outright.
    writeFileSync(
      join(root, 'coupling.yaml'),
      'version: 1\nrules:\n  - id: string-when\n    when: "src/*"\n    require:\n      - kind: changed\n        paths: ["docs/x.md"]\n',
    )
    assert.throws(
      () => execFileSync('node', [GATE, '--plan', 'a.ts'], { cwd: root, encoding: 'utf8', env: GATE_ENV }),
      (err) => {
        assert.equal(err.status, 2, 'a malformed manifest must exit with a code distinct from a coupling violation (1)')
        assert.match(err.stderr, /string-when/)
        assert.match(err.stderr, /"when" must be a list/)
        return true
      },
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('INV-coupling-17 a capture containing glob metacharacters cannot widen the rule it fills', () => {
  // Same root cause as the injection tests above: a capture is a real path
  // segment, so its content is attacker-controlled. Here the blast radius is a
  // requirement that quietly matches more paths than it names, rather than code
  // execution — but a rule that is satisfied by the wrong file is exactly the
  // false reassurance this engine exists to prevent.
  const rule = {
    id: 'module-contract',
    when: ['src/{module}/**', '!src/{module}/CLAUDE.md'],
    require: [{ kind: 'changed', paths: ['src/{module}/CLAUDE.md'] }],
  }
  const violations = evaluate({
    rules: [rule],
    changes: [change('src/ev*l/plan.ts'), change('src/evil/CLAUDE.md')],
    range,
  })
  assert.equal(violations.length, 1, "another module's contract must not satisfy this one")
  assert.equal(violations[0].bindings.module, 'ev*l')
})

test('INV-coupling-18 deleting the target does not satisfy a `changed` requirement', () => {
  // Otherwise the cheapest way to satisfy "document what you did" is to delete
  // the document. Removing a whole module along with its contract is the
  // legitimate case, and it is rare enough to waive deliberately.
  const rule = {
    id: 'module-contract',
    when: ['src/{module}/**', '!src/{module}/CLAUDE.md'],
    require: [{ kind: 'changed', paths: ['src/{module}/CLAUDE.md'] }],
  }
  const violations = evaluate({
    rules: [rule],
    changes: [change('src/core/plan.ts'), change('src/core/CLAUDE.md', 'D')],
    range,
  })
  assert.equal(violations.length, 1)
})

test('INV-coupling-19 adding blank lines does not satisfy `rejectWhitespaceOnly`', () => {
  // `-w` alone still counts an inserted empty line as a real change, so without
  // --ignore-blank-lines the cheapest way to satisfy a documentation rule is to
  // press enter twice.
  const { root, git } = makeRepo()
  const cwd = process.cwd()
  try {
    writeFileSync(join(root, 'f.txt'), 'line one\n')
    git('add', '-A'); git('commit', '-q', '-m', 'init')
    const base = git('rev-parse', 'HEAD').trim()

    writeFileSync(join(root, 'f.txt'), 'line one\n\n\n')
    git('add', '-A'); git('commit', '-q', '-m', 'blank lines only')
    const head = git('rev-parse', 'HEAD').trim()

    const rule = { id: 'ws', when: ['f.txt'], require: [{ kind: 'changed', paths: ['f.txt'], rejectWhitespaceOnly: true }] }
    process.chdir(root)
    const violations = evaluate({ rules: [rule], changes: [change('f.txt')], range: { base, head, source: 'event' } })
    assert.equal(violations.length, 1)
  } finally {
    process.chdir(cwd)
    rmSync(root, { recursive: true, force: true })
  }
})

test('INV-coupling-20 a mode-only change does not satisfy `rejectWhitespaceOnly`', () => {
  // `--numstat` prints a row for a chmod — "0 0 path" — so the presence of
  // output means the file was mentioned, not that anything inside it moved.
  const { root, git } = makeRepo()
  const cwd = process.cwd()
  try {
    const file = join(root, 'f.sh')
    writeFileSync(file, '#!/bin/sh\necho hi\n')
    git('add', '-A'); git('commit', '-q', '-m', 'init')
    const base = git('rev-parse', 'HEAD').trim()

    chmodSync(file, 0o755)
    git('add', '-A'); git('commit', '-q', '-m', 'mode only')
    const head = git('rev-parse', 'HEAD').trim()

    const rule = { id: 'ws', when: ['f.sh'], require: [{ kind: 'changed', paths: ['f.sh'], rejectWhitespaceOnly: true }] }
    process.chdir(root)
    const violations = evaluate({ rules: [rule], changes: [change('f.sh')], range: { base, head, source: 'event' } })
    assert.equal(violations.length, 1, 'zero bytes changed is not a change')
  } finally {
    process.chdir(cwd)
    rmSync(root, { recursive: true, force: true })
  }
})

test('INV-coupling-21 a binary file edit satisfies `rejectWhitespaceOnly`, since there is no text inside it to call whitespace', () => {
  // `git diff --numstat` cannot report line counts for a binary file: it prints
  // "-\t-" instead of two numbers. Reading that as "0 lines changed" would
  // make replacing an image or a font file, byte for byte, invisible to a
  // requirement meant to catch exactly this kind of real change.
  const { root, git } = makeRepo()
  const cwd = process.cwd()
  try {
    writeFileSync(join(root, 'f.bin'), Buffer.from([0, 1, 2, 3]))
    git('add', '-A')
    git('commit', '-q', '-m', 'init binary')
    const base = git('rev-parse', 'HEAD').trim()

    writeFileSync(join(root, 'f.bin'), Buffer.from([4, 5, 6, 7, 8]))
    git('add', '-A')
    git('commit', '-q', '-m', 'replace binary content')
    const head = git('rev-parse', 'HEAD').trim()

    const rule = { id: 'ws', when: ['f.bin'], require: [{ kind: 'changed', paths: ['f.bin'], rejectWhitespaceOnly: true }] }
    process.chdir(root)
    const violations = evaluate({ rules: [rule], changes: [change('f.bin')], range: { base, head, source: 'event' } })
    assert.equal(violations.length, 0, 'a binary file with different bytes must count as a real change')
  } finally {
    process.chdir(cwd)
    rmSync(root, { recursive: true, force: true })
  }
})

test('INV-coupling-22 with no base to diff against, `rejectWhitespaceOnly` treats the path as genuinely changed', () => {
  // There is nothing to run `git diff` against here — see changed.mjs's
  // `resolveRange` and INV-changed-05. The probe must not even try; it must
  // short-circuit to "changed" the same way the rest of this engine treats
  // "no base" as "everything is new".
  const rule = { id: 'ws', when: ['f.txt'], require: [{ kind: 'changed', paths: ['f.txt'], rejectWhitespaceOnly: true }] }
  const violations = evaluate({ rules: [rule], changes: [change('f.txt')], range: { base: null, head: 'HEAD', source: 'no-base' } })
  assert.equal(violations.length, 0, 'no base to diff against must not be read as "nothing changed"')
})

test('INV-coupling-39 the no-base short-circuit fires before any `git diff` runs, even one that would report "no change"', () => {
  // A mutant that skips the `!range.base` early return does not fail loudly:
  // `${range.base}...${range.head}` coerces a JS `null` to the literal string
  // "null", and `git diff` happily resolves that as a ref name if one exists.
  // Give it one, pointed at the same commit as head, so a probe that forgot
  // to short-circuit finds an empty, "nothing changed" diff instead of an
  // error — the one case its own catch-all `return true` cannot rescue it from.
  const { root, git } = makeRepo()
  const cwd = process.cwd()
  try {
    writeFileSync(join(root, 'f.txt'), 'line one\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    const head = git('rev-parse', 'HEAD').trim()
    git('branch', 'null', head)

    const rule = { id: 'ws', when: ['f.txt'], require: [{ kind: 'changed', paths: ['f.txt'], rejectWhitespaceOnly: true }] }
    process.chdir(root)
    const violations = evaluate({ rules: [rule], changes: [change('f.txt')], range: { base: null, head, source: 'no-base' } })
    assert.equal(violations.length, 0, 'the short-circuit must fire on its own condition, not rely on git failing to resolve a ref literally named "null"')
  } finally {
    process.chdir(cwd)
    rmSync(root, { recursive: true, force: true })
  }
})

test('INV-coupling-23 a git failure inside the whitespace probe fails open rather than blocking the pull request', () => {
  // The probe's own `catch` deliberately returns `true` ("never fail a pull
  // request because the whitespace probe itself broke" — see coupling.mjs).
  // Undocumented and unexercised, that line is indistinguishable from a bug
  // that always says "changed" even on a real whitespace-only edit — which is
  // exactly why INV-coupling-11 additionally proves the normal path still
  // rejects whitespace-only edits. This test is the other half: the
  // documented escape hatch itself must actually fire, and must fail open,
  // when the probe cannot run at all.
  const { root, git } = makeRepo()
  const cwd = process.cwd()
  try {
    writeFileSync(join(root, 'f.txt'), 'line one\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    const head = git('rev-parse', 'HEAD').trim()

    const rule = { id: 'ws', when: ['f.txt'], require: [{ kind: 'changed', paths: ['f.txt'], rejectWhitespaceOnly: true }] }
    process.chdir(root)
    // A base that names no object this repository has ever seen: `git diff`
    // exits non-zero and execFileSync throws, driving the probe into its own
    // catch block rather than a real diff result.
    const bogusBase = '0'.repeat(40)
    const violations = evaluate({ rules: [rule], changes: [change('f.txt')], range: { base: bogusBase, head, source: 'event' } })
    assert.equal(violations.length, 0, 'a broken probe must fail open, not block the pull request over its own error')
  } finally {
    process.chdir(cwd)
    rmSync(root, { recursive: true, force: true })
  }
})

test('INV-coupling-24 an ordinary captured value is accepted as safe, and the command it gates genuinely runs', () => {
  // Every existing test of SAFE_CAPTURE (INV-coupling-08) uses a hostile
  // value and checks that the command it would have run never ran. None of
  // them checks the other side of the same allowlist: that a normal capture
  // is NOT refused, and that the command actually executes rather than the
  // check merely declining to complain. A version of the allowlist that
  // refused every capture, safe or not, would pass every existing test here.
  const { root, git } = makeRepo()
  const cwd = process.cwd()
  try {
    mkdirSync(join(root, 'src', 'core'), { recursive: true })
    writeFileSync(join(root, 'src', 'core', 'plan.ts'), 'x')
    git('add', '-A')
    git('commit', '-q', '-m', 'ordinary module')
    const head = git('rev-parse', 'HEAD').trim()

    const marker = 'RAN-command'
    const rule = {
      id: 'per-module-check',
      when: ['src/{module}/**'],
      require: [{ kind: 'command', run: `touch ${marker}` }],
    }
    process.chdir(root)
    const violations = evaluate({
      rules: [rule],
      changes: [{ status: 'A', path: 'src/core/plan.ts' }],
      range: { base: null, head, source: 'no-base' },
    })
    assert.equal(violations.length, 0, 'an ordinary module name must not be refused as an unsafe capture')
    assert.ok(existsSync(join(root, marker)), 'the command must genuinely have run, not merely have gone unreported')
  } finally {
    process.chdir(cwd)
    rmSync(root, { recursive: true, force: true })
  }
})

test('INV-coupling-25 a capture unsafe only in its middle is still refused, not judged by its safe-looking ends alone', () => {
  // SAFE_CAPTURE anchors the whole value (`^...$`), not just a prefix or
  // suffix of it. A capture built to look safe at both ends but hostile in
  // the middle is what an anchor actually buys over a bare character class.
  const { root, git } = makeRepo()
  const cwd = process.cwd()
  try {
    const markerName = 'PWNED-anchor'
    // Starts with word characters, ends with word characters — the two
    // things a missing `^` or a missing `$` alone would still let through —
    // with a space and a semicolon in the middle that only a full-string
    // match can catch.
    const moduleName = `ok;touch ${markerName};doneword`
    mkdirSync(join(root, 'src', moduleName), { recursive: true })
    writeFileSync(join(root, 'src', moduleName, 'f.ts'), 'x')
    git('add', '-A')
    git('commit', '-q', '-m', 'module with an unsafe middle')
    const head = git('rev-parse', 'HEAD').trim()

    const rule = {
      id: 'per-module-check',
      when: ['src/{module}/**'],
      require: [{ kind: 'command', run: 'echo module {module} checked' }],
    }
    process.chdir(root)
    const violations = evaluate({
      rules: [rule],
      changes: [{ status: 'A', path: `src/${moduleName}/f.ts` }],
      range: { base: null, head, source: 'no-base' },
    })
    assert.equal(violations.length, 1, 'safe-looking ends around an unsafe middle must still be refused')
    assert.equal(existsSync(join(root, markerName)), false, 'the injected command must never have run')
  } finally {
    process.chdir(cwd)
    rmSync(root, { recursive: true, force: true })
  }
})

test('INV-coupling-26 a rule that touches the same module through two different paths still produces one violation, not one per path', () => {
  // `triggers()` groups touched paths by the captures they resolved to, using
  // a string key built from the sorted bindings. If that key ever stopped
  // being a string (e.g. the plain array `Object.entries` returns instead of
  // its JSON-stringified form), `Map.has`/`Map.get` would compare by
  // reference, every path would land in its own fresh group, and one module
  // touched via two files would be reported as two separate violations.
  const violations = evaluate({
    rules: [moduleContract],
    changes: [change('src/core/a.ts'), change('src/core/b.ts')],
    range,
  })
  assert.equal(violations.length, 1, 'both paths bind the same capture, so they belong to the same group')
  assert.deepEqual(violations[0].triggeredBy.sort(), ['src/core/a.ts', 'src/core/b.ts'])
})

test('INV-coupling-27 `triggeredBy` is capped at 5 paths even when many more paths triggered the rule', () => {
  const many = Array.from({ length: 8 }, (_, i) => change(`src/core/f${i}.ts`))
  const violations = evaluate({ rules: [moduleContract], changes: many, range })
  assert.equal(violations.length, 1)
  assert.equal(violations[0].triggeredBy.length, 5, 'the list must be capped, not every touched path dumped into one violation')
})

test('INV-coupling-28 a requirement\'s own `fix` is substituted with the capture, and a requirement with no `fix` leaves it unset', () => {
  const ruleWithFix = {
    id: 'with-fix',
    when: ['src/{module}/**'],
    require: [{ kind: 'label', name: 'ok', fix: 'update src/{module}/CLAUDE.md' }],
  }
  const [withFix] = evaluate({ rules: [ruleWithFix], changes: [change('src/core/plan.ts')], range, labels: [] })
  assert.equal(withFix.fix, 'update src/core/CLAUDE.md')

  const ruleWithoutFix = { id: 'no-fix', when: ['a.ts'], require: [{ kind: 'label', name: 'ok' }] }
  const [withoutFix] = evaluate({ rules: [ruleWithoutFix], changes: [change('a.ts')], range, labels: [] })
  assert.equal(withoutFix.fix, undefined, 'a requirement with no `fix` of its own must not invent one')
})

test('INV-coupling-29 deleting a file\'s content down to nothing still counts as a real change under `rejectWhitespaceOnly`', () => {
  // `git --numstat` reports "0\t1\tpath" for a pure deletion (nothing added,
  // one line removed) — the added-lines column alone is "0", same as a
  // no-op. Only the sum of both columns tells a deletion apart from nothing
  // happening at all, so a probe that only looked at one column, or that
  // parsed the row on the wrong separator, would wrongly wave a deletion
  // through as unchanged.
  const { root, git } = makeRepo()
  const cwd = process.cwd()
  try {
    writeFileSync(join(root, 'f.txt'), 'line one\nline two\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    const base = git('rev-parse', 'HEAD').trim()

    writeFileSync(join(root, 'f.txt'), 'line one\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'delete a line')
    const head = git('rev-parse', 'HEAD').trim()

    const rule = { id: 'ws', when: ['f.txt'], require: [{ kind: 'changed', paths: ['f.txt'], rejectWhitespaceOnly: true }] }
    process.chdir(root)
    const violations = evaluate({ rules: [rule], changes: [change('f.txt')], range: { base, head, source: 'event' } })
    assert.equal(violations.length, 0, 'removing a whole line is a real change even though nothing was added')
  } finally {
    process.chdir(cwd)
    rmSync(root, { recursive: true, force: true })
  }
})

test('INV-coupling-30 without `rejectWhitespaceOnly`, a whitespace-only edit still satisfies a plain `changed` requirement', () => {
  // Every existing `rejectWhitespaceOnly` test sets it to `true`. None proves
  // the flip side: that the probe is opt-in, and a rule which never asked for
  // it must not have whitespace-only edits filtered out from under it.
  const { root, git } = makeRepo()
  const cwd = process.cwd()
  try {
    writeFileSync(join(root, 'f.txt'), 'line one\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    const base = git('rev-parse', 'HEAD').trim()

    writeFileSync(join(root, 'f.txt'), 'line one   \n')
    git('add', '-A')
    git('commit', '-q', '-m', 'whitespace only')
    const head = git('rev-parse', 'HEAD').trim()

    const rule = { id: 'ws-default', when: ['f.txt'], require: [{ kind: 'changed', paths: ['f.txt'] }] }
    process.chdir(root)
    const violations = evaluate({ rules: [rule], changes: [change('f.txt')], range: { base, head, source: 'event' } })
    assert.equal(violations.length, 0, 'the opt-in guard must not run at all when rejectWhitespaceOnly was never requested')
  } finally {
    process.chdir(cwd)
    rmSync(root, { recursive: true, force: true })
  }
})

test('INV-coupling-31 an `added` violation and a `changed` violation read differently, and both name the pattern', () => {
  const wanted = ['docs/spec.md']
  const addedRule = { id: 'r-added', when: ['a.ts'], require: [{ kind: 'added', paths: wanted }] }
  const changedRule = { id: 'r-changed', when: ['a.ts'], require: [{ kind: 'changed', paths: wanted }] }
  const [added_] = evaluate({ rules: [addedRule], changes: [change('a.ts')], range })
  const [changed_] = evaluate({ rules: [changedRule], changes: [change('a.ts')], range })
  assert.match(added_.required, /docs\/spec\.md/, 'the required message must name the pattern the agent has to satisfy')
  assert.match(added_.required, /new file/i, 'an `added` violation must tell the agent to create something, not edit it')
  assert.match(changed_.required, /docs\/spec\.md/)
  assert.match(changed_.required, /change/i, 'a `changed` violation must tell the agent to edit something, not create it')
  assert.notEqual(added_.required, changed_.required)
})

test('INV-coupling-32 a `min` greater than 1 is named in the requirement text, and `min: 1` claims no minimum at all', () => {
  const ruleMin2 = { id: 'r-min2', when: ['a.ts'], require: [{ kind: 'added', paths: ['x/*.sql'], min: 2 }] }
  const ruleMin1 = { id: 'r-min1', when: ['a.ts'], require: [{ kind: 'added', paths: ['x/*.sql'] }] }
  const [min2] = evaluate({ rules: [ruleMin2], changes: [change('a.ts'), change('x/one.sql', 'A')], range })
  const [min1] = evaluate({ rules: [ruleMin1], changes: [change('a.ts')], range })
  assert.match(min2.required, /2/, 'the minimum count itself must be visible when more than one is required')
  assert.ok(!min2.required.endsWith('x/*.sql'), 'a min greater than 1 must append something after the pattern, naming the count')
  assert.ok(min1.required.endsWith('x/*.sql'), 'a plain min-1 requirement must not append anything after the pattern')
})

test('INV-coupling-35 multiple acceptable path patterns read as alternatives, not concatenated into one', () => {
  const rule = { id: 'r-alts', when: ['a.ts'], require: [{ kind: 'added', paths: ['x/*.sql', 'y/*.sql'] }] }
  const [v] = evaluate({ rules: [rule], changes: [change('a.ts')], range })
  assert.match(v.required, /x\/\*\.sql\s+or\s+y\/\*\.sql/, 'multiple patterns must be joined as alternatives, not run together')
})

test('INV-coupling-36 a failing command with no output of its own reports an empty detail, not a placeholder', () => {
  const violations = evaluate({
    rules: [{ id: 'silent-fail', when: ['a.ts'], require: [{ kind: 'command', run: 'exit 1' }] }],
    changes: [change('a.ts')],
    range,
  })
  assert.equal(violations.length, 1)
  assert.equal(violations[0].detail, '', 'a command that fails silently must not be reported as if it had said something')
})

test('INV-coupling-37 `rejectWhitespaceOnly` is honoured only for `changed` requirements, never for `added` ones', () => {
  // The whitespace probe must never even run for a kind other than `changed`:
  // it shells out to a real `git diff`, and running it needlessly can only
  // ever turn a satisfied requirement into an unsatisfied one, never the
  // other way around, if the probe (wrongly) finds "no change" in a file the
  // pattern-and-status check alone already accepted.
  const { root, git } = makeRepo()
  const cwd = process.cwd()
  try {
    writeFileSync(join(root, 'unrelated.txt'), 'x')
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    const base = git('rev-parse', 'HEAD').trim()
    writeFileSync(join(root, 'new.sql'), 'CREATE TABLE t();\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'unrelated commit')
    const head = git('rev-parse', 'HEAD').trim()
    // 'unrelated.txt' is byte-identical at base and head -- a real `git diff`
    // against it reports no change at all. The change set below claims it was
    // added anyway; that claim, not git history, is what `added` checks.
    const rule = {
      id: 'added-ws',
      when: ['trigger.ts'],
      require: [{ kind: 'added', paths: ['unrelated.txt'], rejectWhitespaceOnly: true }],
    }
    process.chdir(root)
    const violations = evaluate({
      rules: [rule],
      changes: [
        { status: 'M', path: 'trigger.ts' },
        { status: 'A', path: 'unrelated.txt' },
      ],
      range: { base, head, source: 'event' },
    })
    assert.equal(violations.length, 0, 'the whitespace probe must not run at all for a non-`changed` requirement')
  } finally {
    process.chdir(cwd)
    rmSync(root, { recursive: true, force: true })
  }
})

test('INV-coupling-38 two `when` patterns that bind the same captures in a different order still group into one violation', () => {
  // `bindingKey` must normalise key order (it sorts before stringifying):
  // `match()` builds bindings from a regex's named groups in the order they
  // appear in the *pattern text*, so two different patterns naming the same
  // captures in a different order produce objects with the same entries in a
  // different insertion order -- equal sets, unequal `Object.entries()`.
  const rule = {
    id: 'multi-pattern',
    when: ['src/{module}/{kind}/**', 'other/{kind}/{module}/**'],
    require: [{ kind: 'changed', paths: ['src/{module}/CLAUDE.md'] }],
  }
  const violations = evaluate({
    rules: [rule],
    changes: [change('src/core/impl/a.ts'), change('other/impl/core/b.ts')],
    range,
  })
  assert.equal(
    violations.length,
    1,
    'both paths bind {module: "core", kind: "impl"} -- the same capture set in a different key order -- and must group as one',
  )
})

test('INV-coupling-33 a failing command\'s detail keeps only the tail of its own output, not the whole thing', () => {
  const manyLines = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\\n')
  const violations = evaluate({
    rules: [{ id: 'noisy2', when: ['a.ts'], require: [{ kind: 'command', run: `node -e "console.error('${manyLines}')" ; exit 1` }] }],
    changes: [change('a.ts')],
    range,
  })
  assert.equal(violations.length, 1)
  const detailLines = violations[0].detail.split('\n')
  assert.equal(detailLines.length, 12, 'only the tail must be kept, not the whole output')
  assert.equal(detailLines[0], 'line 8', 'the earliest surviving line is the 9th of 20, the rest trimmed away')
  assert.equal(detailLines[11], 'line 19')
})

test('INV-coupling-34 `--plan` describes every requirement kind in words an agent can act on, captures substituted in', () => {
  const rule = {
    id: 'multi',
    when: ['src/{module}/**'],
    require: [
      { kind: 'added', paths: ['db/migrations/*.sql'] },
      { kind: 'changed', paths: ['src/{module}/CLAUDE.md', 'src/{module}/README.md'] },
      { kind: 'label', name: 'reviewed' },
    ],
  }
  const [entry] = planFor([rule], ['src/core/plan.ts'])
  assert.equal(entry.ruleId, 'multi')
  assert.equal(entry.bindings.module, 'core')
  const [addedObl, changedObl, labelObl] = entry.obligations
  assert.match(addedObl, /new file/i)
  assert.match(addedObl, /db\/migrations/)
  assert.match(changedObl, /change/i)
  assert.match(changedObl, /src\/core\/CLAUDE\.md/, 'the capture must be substituted into the planned obligation too')
  assert.match(
    changedObl,
    /src\/core\/CLAUDE\.md\s+or\s+src\/core\/README\.md/,
    'multiple acceptable paths must read as alternatives, not run together',
  )
  assert.match(labelObl, /reviewed/)
  assert.notEqual(addedObl, changedObl)
})
