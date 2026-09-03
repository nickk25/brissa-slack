#!/usr/bin/env node
/**
 * Regenerate the machine-written parts of every contract.
 *
 *   contracts            rewrite the generated regions in place
 *   contracts --check    regenerate in memory and fail if the file differs
 *   contracts --json     the same result as data
 *
 * `--check` is the half that matters, and it is what a coupling rule of kind
 * `command` should run. It does not ask whether somebody edited the
 * documentation — it asks whether the documentation matches the code, which is
 * the only version of that question an agent cannot satisfy by typing.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { builtins } from './generators/index.mjs'
import { danglingBlocks, duplicateBlocks, findBlocks, render, unterminatedFence } from './lib/blocks.mjs'
import { loadManifest } from './lib/manifest.mjs'

const ROOT = process.cwd()
const MANIFEST = process.env.AGENTIC_MANIFEST ?? 'coupling.yaml'
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next'])

const c = process.stdout.isTTY
  ? { red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m', off: '\x1b[0m' }
  : { red: '', green: '', yellow: '', dim: '', bold: '', off: '' }

/** Every Markdown file in the tree, ignoring the usual noise. */
function markdownFiles(dir = ROOT, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry) || entry.startsWith('.') && entry !== '.github') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) markdownFiles(full, out)
    else if (entry.endsWith('.md')) out.push(full)
  }
  return out
}

/**
 * Built-ins plus whatever the consuming repository dropped into `generators/`.
 * Language-specific generators live there, so this engine never has to know
 * what language it is governing.
 */
async function loadGenerators() {
  const map = Object.fromEntries(Object.values(builtins).map((g) => [g.name, g.generate]))
  const dir = join(ROOT, 'tools/agentic/generators')

  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.mjs') || file === 'index.mjs') continue
    const mod = await import(join(dir, file))
    for (const exported of Object.values(mod)) {
      if (exported?.name && typeof exported.generate === 'function') {
        map[exported.name] = exported.generate
      }
    }
  }
  return map
}

/** The first non-heading, non-blank line of a module's contract. */
function readFirstProse(moduleName, modulesDir = 'src') {
  try {
    const text = readFileSync(join(ROOT, modulesDir, moduleName, 'CLAUDE.md'), 'utf8')
    return text.split('\n').find((l) => l.trim() && !l.startsWith('#') && !l.startsWith('<!--'))?.trim()
  } catch {
    return null
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const check = argv.includes('--check')
  const json = argv.includes('--json')
  const allowEmpty = argv.includes('--allow-empty')

  // Goes through the same loader gate.mjs uses, so a manifest shape that
  // would crash a generator (see the module comment in lib/manifest.mjs) is
  // reported by name here instead of surfacing as an unhandled TypeError.
  const { rules, problems } = loadManifest((isAbsolute(MANIFEST) ? MANIFEST : join(ROOT, MANIFEST)))
  // Every problem a manifest can have is blocking; there is no advisory tier,
  // because a warning that never blocks is the theatre this repository refuses.
  const manifestErrors = problems
  if (manifestErrors.length) {
    if (json) {
      console.log(JSON.stringify({ manifestProblems: manifestErrors }, null, 2))
      process.exit(2)
    }
    console.error(`${c.red}${c.bold}${MANIFEST} problem${manifestErrors.length > 1 ? 's' : ''}${c.off}\n`)
    for (const p of manifestErrors) console.error(`  ${c.red}✗${c.off} ${p.ruleId ? p.message : `${MANIFEST} ${p.message}`}`)
    process.exit(2)
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const generators = await loadGenerators()
  const ctx = { rules, pkg, root: ROOT, readFirstProse }

  const stale = []
  const written = []
  const unknown = []
  const dangling = []
  const duplicate = []
  const unterminated = []
  let checked = 0

  for (const file of markdownFiles()) {
    const before = readFileSync(file, 'utf8')
    const rel = relative(ROOT, file)

    // An unterminated fence blinds maskFences for the rest of the file, so
    // nothing past it can be trusted — not dangling markers, not block counts.
    // Report it on its own and skip the file rather than let it read as clean.
    const openedAt = unterminatedFence(before)
    if (openedAt != null) {
      unterminated.push({ file: rel, line: openedAt })
      continue
    }

    const loose = danglingBlocks(before)
    if (loose.length) dangling.push({ file: rel, names: loose })

    // A duplicate name means render() can only ever reach the first
    // declaration, so the second would look maintained while going
    // unchecked. Report both lines and skip rendering rather than guess.
    const dupes = duplicateBlocks(before)
    if (dupes.length) {
      duplicate.push({ file: rel, dupes })
      continue
    }

    const blocks = findBlocks(before)
    if (!blocks.length) continue
    checked += blocks.length

    const result = await render(before, generators, ctx)
    if (result.unknown.length) unknown.push({ file: rel, names: result.unknown })

    if (result.text === before) continue
    if (check) stale.push({ file: rel, blocks: result.rendered })
    else {
      writeFileSync(file, result.text)
      written.push({ file: rel, blocks: result.rendered })
    }
  }

  const fatal = unterminated.length > 0 || duplicate.length > 0
  // A green --check that examined zero blocks is the exact false reassurance
  // this tool exists to prevent, so treat it as a failure unless asked for.
  const emptyRun = check && checked === 0 && !allowEmpty

  if (json) {
    console.log(JSON.stringify({ stale, written, unknown, dangling, duplicate, unterminated, checked }, null, 2))
    process.exit(stale.length || dangling.length || fatal || emptyRun ? 1 : 0)
  }

  for (const u of unterminated) {
    console.error(`${c.red}✗${c.off} ${u.file}: code fence opened at line ${u.line} is never closed`)
    console.error(`  ${c.dim}Every block after it is invisible to --check, which would otherwise report success having checked nothing.${c.off}`)
  }
  for (const d of duplicate) {
    for (const dup of d.dupes) {
      console.error(`${c.red}✗${c.off} ${d.file}: block "${dup.name}" declared twice (lines ${dup.lines.join(', ')})`)
      console.error(`  ${c.dim}One name, one region. Only the first is ever reachable by name; rename one of them.${c.off}`)
    }
  }
  for (const d of dangling) {
    console.error(`${c.yellow}!${c.off} ${d.file}: opening marker with no close for ${d.names.join(', ')}`)
    console.error(`  ${c.dim}That region is silently unchecked. Close it, or delete the marker.${c.off}`)
  }
  for (const u of unknown) {
    console.error(`${c.yellow}!${c.off} ${u.file}: no generator named ${u.names.join(', ')}`)
    console.error(`  ${c.dim}Left untouched rather than emptied. Add it to tools/agentic/generators/, or remove the block.${c.off}`)
  }

  if (check) {
    if (emptyRun && !fatal) {
      console.error(`${c.red}${c.bold}✗ no generated blocks were found anywhere in the tree${c.off}`)
      console.error(`  ${c.dim}A green check that examined zero blocks is worse than no check at all. Pass --allow-empty if that is genuinely expected.${c.off}`)
      process.exit(1)
    }
    if (fatal) process.exit(1)
    if (!stale.length && !dangling.length && !fatal) {
      console.log(`${c.green}✓${c.off} every generated section matches the code ${c.dim}(${checked} block${checked === 1 ? '' : 's'} checked)${c.off}`)
      return
    }
    if (stale.length) {
      console.error(`\n${c.red}${c.bold}${stale.length} contract${stale.length > 1 ? 's are' : ' is'} out of date${c.off}\n`)
      for (const s of stale) {
        console.error(`${c.red}✗${c.off} ${c.bold}${s.file}${c.off}`)
        console.error(`  ${c.dim}stale sections${c.off}  ${s.blocks.join(', ')}`)
        console.error(`  ${c.dim}fix${c.off}             npm run contracts`)
        console.error('')
      }
    }
    process.exit(1)
  }

  if (fatal) process.exit(1)
  if (!written.length) console.log(`${c.green}✓${c.off} nothing to regenerate.`)
  for (const w of written) console.log(`${c.green}updated${c.off} ${w.file} ${c.dim}(${w.blocks.join(', ')})${c.off}`)
}

main()
