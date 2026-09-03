/**
 * Built-in generators.
 *
 * These are the ones that can be written without knowing the language the
 * project is in: they read the manifest, the package scripts, and the shape of
 * the tree. Anything that needs to parse source — a module's public surface, its
 * real imports — is language-specific and belongs in the consuming repository,
 * dropped into this folder as another `.mjs` file exporting the same shape.
 *
 * A generator is `{ name, generate(ctx) }`. `ctx` carries `{ rules, pkg, root }`.
 * Return Markdown; the caller fences it.
 */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Escape a pipe so a value cannot break out of a Markdown table cell. */
const cell = (s) => String(s).replaceAll('|', '\\|')

const obligation = (r) => {
  if (r.kind === 'command') return `\`${r.run}\` to pass`
  if (r.kind === 'label') return `the \`${r.name}\` label`
  const verb = r.kind === 'added' ? 'a new file matching' : 'a change in'
  return `${verb} ${r.paths.map((p) => `\`${p}\``).join(' or ')}`
}

/**
 * The coupling rules, as a table. Keeps the root contract from drifting away
 * from the manifest that actually runs.
 */
export const coupling = {
  name: 'coupling',
  generate: ({ rules }) => {
    const rows = rules.map((r) => {
      const when = r.when.filter((w) => !w.startsWith('!')).map((w) => `\`${w}\``).join(', ')
      return `| \`${cell(r.id)}\` | ${cell(when)} | ${cell(r.require.map(obligation).join('; '))} |`
    })
    return ['| Rule | Fires when you touch | It will demand |', '| --- | --- | --- |', ...rows].join('\n')
  },
}

/** The scripts an agent is allowed to assume exist. */
export const commands = {
  name: 'commands',
  generate: ({ pkg }) => {
    const rows = Object.keys(pkg.scripts ?? {}).map((k) => `| \`npm run ${cell(k)}\` | \`${cell(pkg.scripts[k])}\` |`)
    return ['| Command | Runs |', '| --- | --- |', ...rows].join('\n')
  },
}

/**
 * One row per module, with the first line of its contract as the purpose.
 *
 * Reading the purpose out of each contract rather than restating it here is the
 * whole trick: the index cannot describe a module differently from how the
 * module describes itself, because it is the same bytes.
 */
export const modules = {
  name: 'modules',
  generate: ({ root, modulesDir = 'src', readFirstProse }) => {
    let names = []
    try {
      names = readdirSync(join(root, modulesDir)).filter((n) =>
        statSync(join(root, modulesDir, n)).isDirectory(),
      )
    } catch {
      return '_No modules yet._'
    }
    if (!names.length) return '_No modules yet._'

    const rows = names.sort().map((n) => `| \`${modulesDir}/${cell(n)}\` | ${cell(readFirstProse(n) ?? '—')} |`)
    return ['| Module | Purpose |', '| --- | --- |', ...rows].join('\n')
  },
}

export const builtins = { coupling, commands, modules }
