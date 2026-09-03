/**
 * Generated regions inside a Markdown file.
 *
 * A contract is part machine, part prose. The machine part is fenced:
 *
 *   <!-- gen:exports -->
 *   ...whatever the generator produced...
 *   <!-- /gen:exports -->
 *
 * The point is not that the region gets rewritten. It is that `--check` can
 * regenerate it and compare, so the question stops being "did somebody edit the
 * documentation" and becomes "is the documentation TRUE". A blank line, a
 * plausible sentence, a convincing lie — none of them survive a byte comparison
 * against the code.
 *
 * Everything outside the fences is prose nobody can verify, and it stays as
 * small as the contract can bear.
 */

/**
 * Blank out fenced code blocks, preserving length so indices stay meaningful.
 *
 * Documentation that explains this syntax has to show it, and an example inside
 * a ``` fence is not a region to fill in. Without this, writing the docs for the
 * feature silently corrupts the docs for the feature.
 *
 * @param {string} text
 */
function maskFences(text) {
  const lines = text.split('\n')
  let inFence = false
  let fence = ''

  const masked = lines.map((line) => {
    const opener = /^ {0,3}(```+|~~~+)/.exec(line)
    if (!inFence && opener) {
      inFence = true
      fence = opener[1][0]
      return line
    }
    if (inFence) {
      const closer = /^ {0,3}(```+|~~~+)\s*$/.exec(line)
      if (closer && closer[1][0] === fence) {
        inFence = false
        return line
      }
      return ' '.repeat(line.length)
    }
    return line
  })

  return masked.join('\n')
}

/**
 * The line (1-based) where a code fence was opened but never closed, or
 * `null` if every fence in the document closes.
 *
 * An unterminated fence makes `maskFences` blank out everything to end of
 * file, which makes `findBlocks` and `danglingBlocks` blind to every block
 * that follows — `contracts --check` would then report success having
 * checked nothing. That has to be caught here, separately, before either of
 * those functions ever get to lie about the block count.
 *
 * @param {string} text
 * @returns {number | null}
 */
export function unterminatedFence(text) {
  const lines = text.split('\n')
  let inFence = false
  let fence = ''
  let openedAt = -1

  lines.forEach((line, i) => {
    const opener = /^ {0,3}(```+|~~~+)/.exec(line)
    if (!inFence && opener) {
      inFence = true
      fence = opener[1][0]
      openedAt = i + 1
      return
    }
    if (inFence) {
      const closer = /^ {0,3}(```+|~~~+)\s*$/.exec(line)
      if (closer && closer[1][0] === fence) inFence = false
    }
  })

  return inFence ? openedAt : null
}

/**
 * Block names declared more than once, with the line (1-based) of every
 * declaration.
 *
 * `render` and `replaceBlock` locate a block by name, so a duplicate name
 * means one region is always reachable and the other never is — it looks
 * maintained and is not. One name, one region; this is what lets a caller
 * refuse to proceed instead of silently picking a winner.
 *
 * @param {string} text
 * @returns {{ name: string, lines: number[] }[]}
 */
export function duplicateBlocks(text) {
  const byName = new Map()
  for (const block of findBlocks(text)) {
    const line = text.slice(0, block.start).split('\n').length
    const lines = byName.get(block.name)
    if (lines) lines.push(line)
    else byName.set(block.name, [line])
  }
  return [...byName.entries()].filter(([, lines]) => lines.length > 1).map(([name, lines]) => ({ name, lines }))
}

/**
 * Every generated block present in a document, in source order.
 * Markers inside a code fence are examples, not regions, and are skipped.
 *
 * @param {string} text
 * @returns {{ name: string, body: string, start: number, end: number, bodyStart: number, bodyEnd: number }[]}
 */
export function findBlocks(text) {
  const scan = maskFences(text)
  // The `d` flag hands back each group's absolute [start, end] in `scan`. That
  // is the only reliable way to locate the body: re-deriving it with
  // `indexOf(m[2], …)` collapses to the search start when the body is empty,
  // which lands one character before where the body actually begins.
  const re = /<!--\s*gen:([a-zA-Z][a-zA-Z0-9_-]*)\s*-->\n?([\s\S]*?)<!--\s*\/gen:\1\s*-->/gd
  const found = []
  let m
  while ((m = re.exec(scan))) {
    const [bodyStart, bodyEnd] = m.indices[2]
    found.push({
      name: m[1],
      body: text.slice(bodyStart, bodyEnd),
      start: m.index,
      end: m.index + m[0].length,
      bodyStart,
      bodyEnd,
    })
  }
  return found
}

/**
 * An opening marker with no matching close. Worth reporting loudly: the region
 * silently stops being checked, which is the failure mode that matters.
 * @param {string} text
 */
export function danglingBlocks(text) {
  const scan = maskFences(text)
  const opened = [...scan.matchAll(/<!--\s*gen:([a-zA-Z][a-zA-Z0-9_-]*)\s*-->/g)].map((m) => m[1])
  const closed = [...scan.matchAll(/<!--\s*\/gen:([a-zA-Z][a-zA-Z0-9_-]*)\s*-->/g)].map((m) => m[1])
  return opened.filter((name) => {
    const i = closed.indexOf(name)
    if (i === -1) return true
    closed.splice(i, 1)
    return false
  })
}

/**
 * Replace one block's body, leaving the markers and everything else untouched.
 * Splices by index rather than by pattern, so an example of the same block in a
 * code fence further down cannot be hit instead.
 *
 * @param {string} text
 * @param {string} name
 * @param {string} body
 */
export function replaceBlock(text, name, body) {
  const block = findBlocks(text).find((b) => b.name === name)
  if (!block) return text
  const normalised = body.endsWith('\n') ? body : `${body}\n`
  return text.slice(0, block.bodyStart) + normalised + text.slice(block.bodyEnd)
}

/**
 * Render every block a document declares, using the generators available.
 *
 * A block whose generator is missing is left alone and reported, rather than
 * emptied. Wiping a region because a generator was renamed would silently
 * delete the only true part of a contract.
 *
 * Refuses to run at all when a block name is duplicated: `replaceBlock` locates
 * by name, so it would keep rewriting the first declaration and never reach the
 * second, which would then read as maintained while actually going unchecked.
 *
 * @param {string} text
 * @param {Record<string, (ctx: any) => string|Promise<string>>} generators
 * @param {any} ctx
 * @returns {Promise<{ text: string, rendered: string[], unknown: string[] }>}
 */
export async function render(text, generators, ctx) {
  const dupes = duplicateBlocks(text)
  if (dupes.length) {
    const detail = dupes.map((d) => `"${d.name}" (lines ${d.lines.join(', ')})`).join(', ')
    throw new Error(`duplicate generated block name: ${detail}`)
  }

  const rendered = []
  const unknown = []
  let out = text

  for (const block of findBlocks(text)) {
    const gen = generators[block.name]
    if (!gen) {
      unknown.push(block.name)
      continue
    }
    out = replaceBlock(out, block.name, await gen(ctx))
    rendered.push(block.name)
  }

  return { text: out, rendered, unknown }
}
