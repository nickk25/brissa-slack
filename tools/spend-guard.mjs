/**
 * The one line between a script and the Anthropic bill.
 *
 * Every API call Brissa makes should be a real person being served. Testing —
 * evaluating a prompt, probing how it behaves, a smoke run — goes through
 * agents on the same model, which cost nothing beyond the subscription already
 * paid for. That was decided after a month in which roughly all of the $7.02
 * spent was testing and none of it was the product doing its job.
 *
 * So the scripts that can spend refuse to unless told, in so many words, that
 * this run was approved. Not a confirmation prompt — a flag, so the decision is
 * visible in the command that was typed and in whatever log recorded it. The
 * flag is consumed here, so a script that reads its arguments positionally never
 * sees it.
 *
 * `src/llm/CLAUDE.md` says when a paid run is worth recommending. The short
 * version: when the shape of the call changes, when an agent eval moves a
 * boundary case, when reality contradicts the eval, or when the model that ships
 * changes. Never routinely, never per deploy, never for thoroughness.
 */

export function requireSpendApproval(what) {
  const at = process.argv.indexOf('--spend')
  if (at !== -1) {
    process.argv.splice(at, 1)
    return
  }
  console.error(`${what} spends real money on the Anthropic API, and is refused by default.\n`)
  console.error('API spend is for real usage only. Testing goes through agents on the same model:')
  console.error('  npm run eval:agent-job      prepare the cases for agents to answer')
  console.error('  npm run eval:agent-record   score what they answered\n')
  console.error('If a paid run has been approved for a specific reason, pass --spend.')
  console.error('When one is worth recommending is written down in src/llm/CLAUDE.md, under Calibration.')
  process.exit(2)
}
