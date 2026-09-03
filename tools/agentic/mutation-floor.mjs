#!/usr/bin/env node
/**
 * Per-file mutation score floor.
 *
 * `stryker.config.json`'s `break: 60` is a global average, and a global
 * average is exactly the kind of number that looks like a control and is
 * not: a file that kills almost every mutant subsidises one that kills
 * almost none, and the score that gates CI never learns the difference. That
 * is not hypothetical here — it already happened once. `timeline.mjs` sat at
 * 58.63%, *below* the global break threshold, while the overall score still
 * read 76.76% and passed, because `glob.mjs` (97.66%) and `manifest.mjs`
 * (92.39%) were strong enough to carry it. A reviewer who only reads the one
 * number CI reports would never find out the measurement code was the
 * weakest thing in the repository.
 *
 * This script reads the same report `stryker run` already produced and fails
 * the moment any mutated file falls under FLOOR, so no single file can ever
 * hide behind the others' average again.
 *
 * FLOOR = 65. Chosen, not aspired to: every file this repository mutates
 * meets it today (measured, not estimated) --
 *   changed.mjs   97.10   manifest.mjs  100.00
 *   coupling.mjs  95.63   blocks.mjs     81.66
 *   glob.mjs      97.66   timeline.mjs   70.68
 * `coupling.mjs` and `changed.mjs` -- the rule engine and change detection
 * everything else in this repository rests on -- got the deepest pass, up
 * from 64.32 and 85.54. `timeline.mjs` is measurement, not enforcement (see
 * its own file docstring), so it was deliberately not chased to the same
 * bar; it still moved from 58.63, the file that motivated this script in the
 * first place, once its "coupling" and "invariant.count" sections turned out
 * to have no test touching them at all. 65 sits comfortably under all six
 * scores above as of this commit and a solid margin above zero effort, so
 * raising it further is honest future work, not a correction to a number
 * that never should have passed. Move the floor only by raising a file's
 * score to clear a higher one, never by lowering the number to let a file
 * back under it.
 */
import { readFileSync } from 'node:fs'
import { argv } from 'node:process'
import { pathToFileURL } from 'node:url'

const REPORT_PATH = process.argv[2] ?? 'reports/mutation/mutation.json'
const FLOOR = 65

/**
 * Files held to their own current score instead of the floor.
 *
 * A threshold nobody meets cannot do the one job a threshold has. If this check
 * is red every week because of a gap everyone already knows about, the next
 * regression lands invisibly against that red, and the check is worse than
 * absent. So a file below the floor is pinned at what it scores today: it can
 * only go up, the gap stays on the report rather than being grandfathered into
 * the floor, and a real regression anywhere still turns the run red.
 *
 * A ratchet, not an exemption: raise the number when the score rises, never
 * lower it to let a file back under. Delete the entry once the file clears
 * FLOOR — the check tells you when.
 */
const RATCHET = {
  // Empty, and that is the goal state: every mutated file clears FLOOR on its
  // own. An entry here is a temporary pin for a file that does not, so it can
  // still be caught regressing while the gap stays visible.
}

// Mutants Stryker itself never scores (a mutant it decided not to generate,
// or one that failed to even compile) are excluded from the denominator, the
// same way Stryker's own "mutation score" already does -- otherwise this
// script and the number `stryker run` just printed could disagree over
// nothing more than how a no-op mutant is counted.
const EXCLUDED = new Set(['Ignored', 'CompileError'])
const KILLED = new Set(['Killed', 'Timeout'])

/** @returns {number|null} a file's mutation score, or null if it has no scoreable mutants */
function scoreOf(mutants) {
  let killed = 0
  let valid = 0
  for (const m of mutants) {
    if (EXCLUDED.has(m.status)) continue
    valid++
    if (KILLED.has(m.status)) killed++
  }
  // Rounded to two places before it is ever compared: 586/1000 is
  // 58.599999999999994 in binary floating point, so a file sitting exactly on
  // its bar would fail by a rounding error nobody could see in the report.
  return valid === 0 ? null : Math.round((killed / valid) * 10000) / 100
}

/**
 * Which files fail, and which have outgrown their pin.
 *
 * Exported and pure so the mechanism can be tested without depending on what
 * RATCHET happens to hold today — the entries are data that changes as files
 * improve, and a test that breaks when the data is correct is a test that
 * teaches people to delete tests.
 *
 * @param {{path: string, score: number}[]} scored
 * @param {Record<string, number>} ratchet
 * @param {number} floor
 */
export function judge(scored, ratchet = RATCHET, floor = FLOOR) {
  const barFor = (path) => ratchet[path.split('/').pop()] ?? floor
  return {
    failing: scored.filter((f) => f.score < barFor(f.path)).sort((a, b) => a.score - b.score),
    graduated: scored.filter((f) => ratchet[f.path.split('/').pop()] !== undefined && f.score >= floor),
  }
}

// Only when run as a command. The tests import this module for `judge`, and a
// module that runs itself on import turns "borrow one function" into "run the
// whole tool" — which then fails everywhere the report is absent, meaning
// everywhere except a machine that has just run the mutator.
if (import.meta.url === pathToFileURL(argv[1] ?? '').href) {
  let report
  try {
    report = JSON.parse(readFileSync(REPORT_PATH, 'utf8'))
  } catch (err) {
    console.error(`mutation-floor: could not read or parse ${REPORT_PATH}: ${err.message}`)
    console.error('Run `npm run mutate` first -- this script only reads its report, it does not run Stryker itself.')
    process.exit(2)
  }

  const files = report.files ?? {}
  const scored = Object.entries(files)
    .map(([path, file]) => ({ path, score: scoreOf(file.mutants ?? []) }))
    .filter((f) => f.score !== null)

  if (scored.length === 0) {
    console.error(`mutation-floor: ${REPORT_PATH} named no file with a scoreable mutant -- nothing was measured`)
    process.exit(2)
  }

  const { failing, graduated } = judge(scored)

  if (failing.length > 0) {
    console.error(`Per-file mutation floor not met by ${failing.length} of ${scored.length} file(s):`)
    for (const f of failing) console.error(`  ${f.score.toFixed(2)}%  ${f.path}`)
    console.error('')
    console.error('A weak file no longer gets to hide behind a strong one\'s average. Add tests for the survivors')
    console.error(`reports/mutation/mutation.html`)
    console.error('names, or delete the code they reveal as dead, until the file above clears the floor.')
    process.exit(1)
  }

  for (const f of graduated) {
    console.log(`${f.path} now scores ${f.score.toFixed(1)}%, above the ${FLOOR}% floor — drop its RATCHET entry.`)
  }
  console.log(`Per-file mutation floor (${FLOOR}%, ratcheted: ${Object.keys(RATCHET).join(', ') || 'none'}): all ${scored.length} mutated file(s) clear their bar.`)
  for (const f of scored.sort((a, b) => a.score - b.score).slice(0, 3)) {
    console.log(`  ${f.score.toFixed(2)}%  ${f.path}`)
  }
}
