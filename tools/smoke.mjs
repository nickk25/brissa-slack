#!/usr/bin/env node
/**
 * One real message, all the way through, without waiting for a colleague.
 *
 *   npm run smoke -- C0123456 "Passt bei mir auch, ich melde mich morgen."
 *
 * Brissa never translates your own messages — that is the first rule it applies,
 * and it means the only way to see it work in a real workspace is for somebody
 * else to write something. This stands in for that somebody: it invents an
 * author who is not you, and runs the genuine pipeline from there. Real model,
 * real Slack, real ephemeral in your client.
 *
 * It lives in `tools/` rather than `src/` because it is not part of the product
 * and nothing may come to depend on it. What it must not do is reimplement any
 * of the pipeline: every decision below is made by the same functions the
 * running app uses, or the smoke test would be proving that a different program
 * works.
 */

import { readFileSync } from 'node:fs'
import { argv, env, exit } from 'node:process'

const { handleMessage } = await import('../src/app/handle.ts')
const { readConfig } = await import('../src/app/config.ts')
const { describe } = await import('../src/app/report.ts')
const { defaultTranslator } = await import('../src/llm/decide.ts')
const { createSlackApi } = await import('../src/slack/web.ts')
const { createMemoryDirectory } = await import('../src/store/memory.ts')

const [channelId, ...words] = argv.slice(2)
const text = words.join(' ')

if (!channelId || !text) {
  console.error('usage: npm run smoke -- <channel-id> "<a message in a language you do not read>"')
  console.error('\nThe channel id is printed on every line `npm start` logs, and shown in Slack')
  console.error('under the channel name → About → at the bottom.')
  exit(1)
}

const configured = readConfig(env)
if (!configured.ok) {
  console.error('Cannot run:\n')
  for (const problem of configured.problems) console.error(`  · ${problem}`)
  exit(1)
}
const { config } = configured

// The one thing this fakes, and the reason it exists: an author who is not you.
const AUTHOR = 'U-SMOKE-TEST'

const ports = {
  directory: createMemoryDirectory({
    readers: config.readers,
    // Enabled for this one channel regardless of BRISSA_CHANNELS, because being
    // told "channel-disabled" is not what anybody runs a smoke test to find out.
    channels: [{ channelId, enabled: true }],
  }),
  translator: defaultTranslator(config.model),
  slack: createSlackApi(config.botToken),
}

console.log(`Pretending ${AUTHOR} wrote this in ${channelId}:\n`)
console.log(`  ${text}\n`)
console.log(`Reading for: ${config.readers.map((r) => `${r.userId} (${r.reads.join(', ')})`).join(', ')}`)
console.log(`Model:       ${config.model}\n`)

const outcome = await handleMessage(ports, {
  type: 'message',
  channel: channelId,
  user: AUTHOR,
  text,
  ts: String(Date.now() / 1000),
})

console.log(`→ ${describe(outcome)}\n`)

if (outcome.kind === 'considered' && outcome.readers.some((r) => r.kind === 'delivered')) {
  console.log('Look in Slack: the translation is in that channel, visible only to you.')
} else if (outcome.kind === 'considered' && outcome.readers.every((r) => r.kind === 'silent')) {
  console.log('Brissa stayed silent, which means it judged that message readable by you.')
  console.log('That is the product working. Try a language you genuinely do not read.')
} else {
  // Anything else is worth the full shape rather than a summary: this is the
  // one run where somebody is watching and can act on it.
  console.log(JSON.stringify(outcome, null, 2))
  console.log('\nIf a reader was "not in channel", invite Brissa there first:')
  console.log('  channel name → Integrations → Add an App → Brissa')
}

// A courtesy for anyone reading this file to copy it: the prompt is read from
// disk by the translator, so this really is the same bytes the eval scored.
void readFileSync
