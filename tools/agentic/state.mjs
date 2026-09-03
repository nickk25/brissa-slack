#!/usr/bin/env node
/**
 * Measure the repository, store the measurement, render the state page.
 *
 *   state snapshot   take a measurement and keep it
 *   state render     rebuild docs/state.json and docs/state.html from the history
 *   state            both
 *
 * Two readers, one page, two densities. The top answers "does it work and what
 * broke" in a glance — that is the whole of it for a human, and about eighty per
 * cent of it for an agent starting cold. Everything below is detail only an
 * agent scrolls to.
 *
 * The JSON is the artefact that matters. Agents read `docs/state.json`; the HTML
 * is a view of it and never the other way round. Nothing here is written by a
 * model: every value is measured, because an agent asked to describe its own
 * work is reliably optimistic.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { builtins } from './probes/index.mjs'
import { diff, health, openRegressions, refuseDirty } from './lib/timeline.mjs'

const ROOT = process.cwd()
const STORE = join(ROOT, '.agentic/snapshots')
const OUT = join(ROOT, 'docs')

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim()

async function loadProbes() {
  const map = { ...builtins }
  const dir = join(ROOT, 'tools/agentic/probes')
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.mjs') || file === 'index.mjs') continue
    const mod = await import(join(dir, file))
    for (const p of Object.values(mod)) {
      if (p?.name && typeof p.measure === 'function') map[p.name] = p
    }
  }
  return map
}

const snapshots = () =>
  (existsSync(STORE) ? readdirSync(STORE).filter((f) => f.endsWith('.json')).sort() : []).map((f) =>
    JSON.parse(readFileSync(join(STORE, f), 'utf8')),
  )

async function takeSnapshot(allowDirty = false) {
  // Cleanliness is checked before anything is measured: a snapshot stamped
  // `git rev-parse HEAD` while the working tree has uncommitted changes
  // measures code that commit never contained. Fail fast rather than
  // measure first and discover the lie afterwards.
  const dirty = sh('git', ['status', '--porcelain']).length > 0
  const refusal = refuseDirty(dirty, allowDirty)
  if (refusal) throw new Error(refusal)

  const probes = await loadProbes()
  const ctx = { root: ROOT }
  const measured = {}
  for (const probe of Object.values(probes)) {
    try {
      measured[probe.name] = await probe.measure(ctx)
    } catch (err) {
      measured[probe.name] = { error: String(err?.message ?? err) }
    }
  }

  const snap = {
    ts: new Date().toISOString(),
    sha: sh('git', ['rev-parse', 'HEAD']),
    subject: sh('git', ['log', '-1', '--pretty=%s']),
    // Explicit, not inferred: a reader must be able to tell a measurement of
    // HEAD apart from a measurement of HEAD-plus-whatever-was-on-disk without
    // re-deriving it from git. A measurement that cannot say what it measured
    // is worse than none.
    dirty,
    probes: measured,
  }

  mkdirSync(STORE, { recursive: true })
  const seq = String(snapshots().length + 1).padStart(4, '0')
  writeFileSync(join(STORE, `${seq}-${snap.sha.slice(0, 7)}.json`), `${JSON.stringify(snap, null, 2)}\n`)
  return snap
}

function build() {
  const history = snapshots()
  if (!history.length) return null

  const entries = []
  for (let i = 0; i < history.length; i++) {
    for (const e of diff(history[i - 1] ?? null, history[i])) entries.push({ ...e, sha: history[i].sha })
  }

  const latest = history.at(-1)
  const open = openRegressions(entries)
  const inv = latest.probes.invariants ?? {}
  const failing = latest.probes.tests?.failing ?? []
  const violations = latest.probes.coupling?.violations ?? []
  // `measured: false` means the gate declined to evaluate anything, not that it
  // found nothing. Reading only `violations` turns the refusal back into a green
  // zero one layer above the probe that was fixed to report it.
  const unmeasured = latest.probes.coupling?.measured === false
  const dirty = latest.dirty === true

  return {
    generatedAt: new Date().toISOString(),
    head: { sha: latest.sha, subject: latest.subject, ts: latest.ts, dirty },
    // A dirty snapshot goes red regardless of its other numbers: those numbers
    // may describe code that was never committed, and trusting them is the
    // exact failure this whole file exists to catch.
    status: dirty || failing.length || violations.length || open.length ? 'red' : unmeasured || inv.uncovered?.length ? 'amber' : 'green',
    numbers: {
      invariantsCovered: inv.covered ?? 0,
      invariantsDeclared: inv.declared ?? 0,
      failingTests: failing.length,
      couplingViolations: violations.length,
    },
    redZones: [
      ...(dirty ? [{ what: 'dirty snapshot', detail: 'The latest snapshot measured a working tree with uncommitted changes.' }] : []),
      ...(unmeasured ? [{ what: 'coupling not measured', detail: 'The gate had no change set to evaluate, so this says nothing about whether the rules hold.' }] : []),
      ...failing.map((t) => ({ what: 'failing test', detail: t })),
      ...violations.map((v) => ({ what: 'coupling violation', detail: `${v.rule}: ${v.required}` })),
      ...(inv.uncovered ?? []).map((i) => ({ what: 'invariant with no test', detail: i })),
      ...(inv.undocumented ?? []).map((i) => ({ what: 'test with no invariant', detail: i })),
      ...open.map((r) => ({ what: 'open regression', detail: `${r.kind} · ${r.subject}` })),
    ],
    health: health(entries, history.length),
    timeline: entries.slice().reverse().slice(0, 60),
    modules: latest.probes.modules ?? {},
  }
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

function html(state) {
  const dot = { green: '#0F766E', amber: '#9A5B08', red: '#B4232A' }[state.status]
  const say = { green: 'Everything declared is holding.', amber: 'Holding, with claims nobody checks.', red: 'Something declared is broken.' }[state.status]

  const rows = state.timeline
    .map(
      (e) => `<tr class="${e.severity}">
      <td class="nw">${esc(e.ts.slice(0, 10))}</td>
      <td class="nw"><code>${esc(e.kind)}</code></td>
      <td>${esc(e.subject)}</td>
      <td class="nw">${e.from !== undefined ? `${esc(e.from)} → ` : ''}${e.to !== undefined ? esc(e.to) : ''}</td>
    </tr>`,
    )
    .join('\n')

  const zones = state.redZones.length
    ? state.redZones.map((z) => `<li><b>${esc(z.what)}</b> ${esc(z.detail)}</li>`).join('')
    : '<li class="ok">Nothing is broken right now.</li>'

  return `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>State</title>
<style>
:root{--bg:#EFF2F5;--card:#fff;--ink:#12161C;--body:#2C343E;--muted:#6A7683;--line:#DCE2E9;--up:#0F766E;--down:#B4232A}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0C1015;--card:#141A21;--ink:#E9EDF2;--body:#BFC8D2;--muted:#8391A0;--line:#242E38;--up:#3FCFBC;--down:#F2777E}}
:root[data-theme=dark]{--bg:#0C1015;--card:#141A21;--ink:#E9EDF2;--body:#BFC8D2;--muted:#8391A0;--line:#242E38;--up:#3FCFBC;--down:#F2777E}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--body);font:15px/1.55 ui-sans-serif,system-ui,sans-serif}
.wrap{max-width:900px;margin:0 auto;padding:40px 24px 80px;display:flex;flex-direction:column;gap:32px}
h1{font-size:15px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin:0;font-weight:600}
.hero{display:flex;align-items:center;gap:16px}
.dot{width:34px;height:34px;border-radius:50%;background:${dot};flex:none}
.hero p{margin:0;font-size:22px;color:var(--ink);font-weight:600;letter-spacing:-.02em}
.nums{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.num{background:var(--card);border:1px solid var(--line);border-radius:4px;padding:14px 16px}
.num b{display:block;font-size:26px;color:var(--ink);font-variant-numeric:tabular-nums}
.num span{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
li{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--down);border-radius:4px;padding:10px 14px;font-size:14px}
li.ok{border-left-color:var(--up);color:var(--muted)}
li b{color:var(--ink)}
.scroll{overflow-x:auto;border:1px solid var(--line);border-radius:4px;background:var(--card)}
table{width:100%;border-collapse:collapse;font-size:13.5px;min-width:560px}
th{text-align:left;padding:9px 14px;font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--line)}
td{padding:9px 14px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:none}
tr.up td:first-child{box-shadow:inset 3px 0 var(--up)}
tr.down td:first-child{box-shadow:inset 3px 0 var(--down)}
.nw{white-space:nowrap}
code{font-family:ui-monospace,monospace;font-size:.9em;color:var(--ink)}
footer{font-size:12px;color:var(--muted);font-family:ui-monospace,monospace}
</style>
<div class="wrap">
  <div class="hero"><div class="dot"></div><p>${esc(say)}</p></div>

  <div class="nums">
    <div class="num"><b>${state.numbers.invariantsCovered}/${state.numbers.invariantsDeclared}</b><span>invariants with a test</span></div>
    <div class="num"><b>${state.numbers.failingTests}</b><span>failing tests</span></div>
    <div class="num"><b>${state.health.openRegressions}</b><span>open regressions</span></div>
  </div>

  <section><h1>Where not to step</h1><ul>${zones}</ul></section>

  <section><h1>What actually changed</h1>
    <div class="scroll"><table>
      <thead><tr><th>When</th><th>Kind</th><th>Subject</th><th>Change</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4">No transitions recorded yet.</td></tr>'}</tbody>
    </table></div>
  </section>

  <footer>${esc(state.head.sha.slice(0, 7))}${state.head.dirty ? ' (dirty)' : ''} · ${esc(state.head.subject)} · generated ${esc(state.generatedAt.slice(0, 16).replace('T', ' '))} UTC<br>
  A merge that moves nothing measurable produces no entry. This measures effect, not effort.</footer>
</div>
`
}

async function main() {
  const rest = process.argv.slice(2)
  const cmd = rest.find((a) => !a.startsWith('--')) ?? 'all'
  // Opt-in only, and only for local experimentation: a dirty snapshot is
  // still recorded (marked `dirty: true`), never silently measured as clean.
  const allowDirty = rest.includes('--allow-dirty')

  if (cmd === 'snapshot' || cmd === 'all') {
    let s
    try {
      s = await takeSnapshot(allowDirty)
    } catch (err) {
      console.error(err.message)
      process.exitCode = 1
      return
    }
    console.log(`snapshot ${s.sha.slice(0, 7)}${s.dirty ? ' (dirty)' : ''} taken`)
  }
  if (cmd === 'render' || cmd === 'all') {
    const state = build()
    if (!state) return console.error('No snapshots yet. Run `state snapshot` first.')
    mkdirSync(OUT, { recursive: true })
    writeFileSync(join(OUT, 'state.json'), `${JSON.stringify(state, null, 2)}\n`)
    writeFileSync(join(OUT, 'state.html'), html(state))
    console.log(`state: ${state.status} · ${state.redZones.length} red zone(s) · ${state.timeline.length} transition(s)`)
  }
}

main()
