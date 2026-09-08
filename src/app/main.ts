/**
 * The composition root: the one place where every interface meets a real thing.
 *
 * Everywhere else in this repository, a port is satisfied by whatever the caller
 * hands over. Here it is satisfied by the Anthropic SDK, by Slack's websocket, by
 * a set in memory — and this is deliberately the only file where those names
 * appear together. Everything above it can be tested without a network because
 * this file is where the network is.
 *
 * It is also the only file that reads `process.env`.
 */

import { argv } from 'node:process'
import { pathToFileURL } from 'node:url'
import { defaultTranslator } from '../llm/decide.ts'
import { connectSocketMode } from '../slack/socket.ts'
import { createSlackApi } from '../slack/web.ts'
import { createMemoryDirectory } from '../store/memory.ts'
import { createMemorySeen } from '../store/seen.ts'
import { readConfig } from './config.ts'
import { describe } from './report.ts'
import { acceptEnvelope, type Work } from './http.ts'

export function main(): void {
  const configured = readConfig(process.env)

  if (!configured.ok) {
    console.error('Brissa cannot start:\n')
    for (const problem of configured.problems) console.error(`  · ${problem}`)
    console.error('\nSee .env.example for what each variable is and where it comes from.')
    process.exitCode = 1
    return
  }

  const { config } = configured

  const work: Work = {
    ports: {
      directory: createMemoryDirectory({
        readers: config.readers,
        channels: config.channels,
        // The decision `src/store` refuses to make on its own, made here: a
        // channel nobody has switched Brissa on in is a channel it stays out of.
        unknownChannels: 'disabled',
      }),
      translator: defaultTranslator(config.model),
      slack: createSlackApi(config.botToken),
    },
    seen: createMemorySeen(),
    // Replaced per envelope below, so each line can name the channel it is about.
    report: (outcome) => console.log(`  ${describe(outcome)}`),
  }

  console.log(`Brissa is listening as ${config.model}.`)
  console.log(`  readers   ${config.readers.map((r) => `${r.userId} reads ${r.reads.join(', ')}`).join(' · ')}`)
  console.log(
    config.channels.length > 0
      ? `  channels  ${config.channels.map((c) => c.channelId).join(', ')}`
      : '  channels  none — set BRISSA_CHANNELS, or Brissa will stay silent everywhere',
  )

  const connection = connectSocketMode({
    appToken: config.appToken,
    onStatus: (status) => console.log(`  ${status}`),
    onEnvelope: (envelope) => {
      // The channel is printed with every outcome for one unglamorous reason:
      // switching Brissa on in a channel needs that channel's id, and there is
      // nowhere in Slack's interface that shows it. Seeing a message arrive is
      // how you find out what to put in `BRISSA_CHANNELS`.
      const where = envelope.kind === 'event' ? (envelope.event.channel ?? '?') : envelope.kind

      // Not awaited, and that is the ordering the whole edge is built around:
      // the socket acknowledged the envelope before this ran.
      void acceptEnvelope(
        {
          ...work,
          report: (outcome) => {
            console.log(`  ${where}  ${describe(outcome)}`)
            // The one thing a first run needs to be told, said where it is
            // noticed rather than in a README nobody has open.
            if (outcome.kind === 'considered' && outcome.readers.every((r) => r.kind === 'skipped' && r.because === 'channel-disabled')) {
              console.log(`            add ${where} to BRISSA_CHANNELS in .env and restart to switch Brissa on here`)
            }
          },
        },
        envelope,
      )
    },
  })

  const stop = () => {
    console.log('\nStopping.')
    connection.close()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

// Guarded so a test can import `describe` without starting a websocket.
if (argv[1] !== undefined && import.meta.url === pathToFileURL(argv[1]).href) main()
