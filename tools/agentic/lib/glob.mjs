/**
 * Path patterns with named captures.
 *
 * A deliberately small glob dialect, because coupling rules are read and written
 * by agents and every extra feature is another thing to get subtly wrong:
 *
 *   *          one path segment, no separators
 *   **         any number of segments, separators included
 *   ?          a single character, not a separator
 *   {name}     one path segment, captured under `name`
 *   !pattern   negation, only meaningful in a pattern list
 *
 * `{name}` is what makes one rule cover every module: `src/{module}/**` matches
 * each module folder and reports which one it matched, so the rule fans out
 * without anybody listing the modules by hand.
 *
 * Negation is evaluated over the whole list, not the prefix seen so far: once
 * any `!pattern` matches, the path is excluded no matter where that negation
 * sits relative to the positive patterns, and there is no way to re-include it
 * afterwards. That is a deliberate trade-off, not an oversight — these lists
 * are written and read by agents, and a result that depends on pattern order
 * is a result nobody can eyeball correctly. Predictability wins over the extra
 * expressiveness order-dependent re-inclusion would buy.
 */

const SPECIAL = /[.+^$()|[\]\\]/g

/**
 * Compile a pattern into a regular expression with named groups.
 * @param {string} pattern
 * @returns {{ re: RegExp, captures: string[] }}
 */
export function compile(pattern) {
  /** @type {string[]} */
  const captures = []
  let re = ''

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]

    // A backslash makes the next character literal. This exists so a value
    // captured from a real path can be substituted back into a pattern without
    // becoming one: a directory named `evil*` bound into `src/{module}/x` and
    // recompiled would otherwise match far more than the single path the rule
    // meant to require. See `escapeGlob`.
    if (ch === '\\' && i + 1 < pattern.length) {
      // Escaped for the regular expression, not for this pattern language:
      // the character has already lost its glob meaning by being escaped here,
      // and now has to lose its regex meaning too. SPECIAL alone is not enough
      // — it deliberately leaves `*` and `?` alone, since unescaped they are
      // this language's own wildcards.
      re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      continue
    }

    if (ch === '{') {
      const end = pattern.indexOf('}', i)
      if (end === -1) throw new Error(`unterminated capture in pattern: ${pattern}`)
      const name = pattern.slice(i + 1, end)
      if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) {
        throw new Error(`invalid capture name "${name}" in pattern: ${pattern}`)
      }
      if (captures.includes(name)) throw new Error(`duplicate capture "${name}" in pattern: ${pattern}`)
      captures.push(name)
      re += `(?<${name}>[^/]+)`
      i = end
      continue
    }

    if (ch === '*') {
      const isDouble = pattern[i + 1] === '*'
      if (isDouble) {
        // `a/**/b` should also match `a/b`, so swallow the following separator.
        if (pattern[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 2
        } else {
          re += '.*'
          i += 1
        }
      } else {
        re += '[^/]*'
      }
      continue
    }

    if (ch === '?') {
      re += '[^/]'
      continue
    }

    re += ch.replace(SPECIAL, '\\$&')
  }

  return { re: new RegExp(`^${re}$`), captures }
}

/**
 * Match a path, returning its captures (an empty object when the pattern has none).
 * @param {string} pattern
 * @param {string} path
 * @returns {Record<string,string>|null}
 */
export function match(pattern, path) {
  const { re } = compile(pattern)
  const m = re.exec(path)
  return m ? { ...m.groups } : null
}

/**
 * Match against a list where entries starting with `!` subtract.
 * A path is included when some positive pattern matches and no negative one does.
 *
 * When several positive patterns match, the one binding the most capture names
 * wins (ties keep the earliest match). A path can satisfy multiple patterns at
 * once — e.g. both `src/**` and `src/{module}/**` match `src/core/plan.ts` —
 * and picking the first one arbitrarily would drop captures a later, more
 * specific pattern would have bound, silently breaking any caller that
 * substitutes them back into a required path.
 * @param {string[]} patterns
 * @param {string} path
 * @returns {Record<string,string>|null}
 */
export function matchList(patterns, path) {
  /** @type {Record<string,string>|null} */
  let hit = null
  let hitCaptures = -1
  for (const p of patterns) {
    if (p.startsWith('!')) {
      if (match(p.slice(1), path)) return null
    } else {
      const m = match(p, path)
      if (m && Object.keys(m).length > hitCaptures) {
        hit = m
        hitCaptures = Object.keys(m).length
      }
    }
  }
  return hit
}

/**
 * Neutralise a value so it can be substituted into a pattern without becoming
 * one.
 *
 * Captures come from real path segments, which an attacker — or a careless
 * rename — controls. This is the same class of bug as passing a capture to a
 * shell: attacker-controlled text re-entering a language that gives certain
 * characters meaning. The blast radius is smaller (a rule matches more paths
 * than intended) but the fix is the same shape.
 *
 * @param {string} value
 */
export function escapeGlob(value) {
  return value.replace(/[*?{}\\]/g, (ch) => `\\${ch}`)
}

/**
 * Replace `{name}` placeholders with concrete values, leaving any placeholder
 * with no binding untouched.
 *
 * DISPLAY ONLY. A leftover `{name}` looks harmless here, but if the result is
 * ever compiled as a pattern again, `{name}` matches a whole segment — an
 * unbound capture quietly turns into a wildcard. Use this only where the
 * output is shown to a human and never fed back into `compile`/`match`. Any
 * caller that gates something (a required-path check, a rule that gets
 * re-matched) must use `substituteStrict` instead.
 * @param {string} pattern
 * @param {Record<string,string>} bindings
 */
export function substitute(pattern, bindings) {
  return pattern.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (whole, name) =>
    name in bindings ? bindings[name] : whole,
  )
}

/**
 * Replace `{name}` placeholders with concrete values, throwing when a name has
 * no binding instead of leaving it in place.
 *
 * FOR ANYTHING THAT GATES. This is the counterpart to `substitute`: silently
 * matching more than intended (an unbound capture degrading into a wildcard)
 * is worse than failing loudly, so callers that turn the result into a
 * required path or a pattern to re-match must use this, not `substitute`.
 * @param {string} pattern
 * @param {Record<string,string>} bindings
 * @returns {string}
 */
export function substituteStrict(pattern, bindings) {
  return pattern.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (whole, name) => {
    if (!(name in bindings)) {
      throw new Error(`unbound capture "${name}" in pattern: ${pattern}`)
    }
    return bindings[name]
  })
}
