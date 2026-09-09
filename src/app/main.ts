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
import { readCommand } from '../slack/command.ts'
import { readEnrolCommand } from '../slack/enrol.ts'
import { createSlackHistory, whoOwns } from '../slack/history.ts'
import { readShortcut } from '../slack/shortcut.ts'
import { createSlackApi } from '../slack/web.ts'
import { createFileEnrolment } from '../store/enrolment.ts'
import { createMemoryDirectory } from '../store/memory.ts'
import { createMemorySeen } from '../store/seen.ts'
import { readConfig } from './config.ts'
import { handleCommand, refuseCommand } from './command.ts'
import { ENROL_COMMAND, handleEnrol } from './enrol.ts'
import { handleShortcut } from './shortcut.ts'
import { describe } from './report.ts'
import { acceptEnvelope, type Work } from './http.ts'

export async function main(): Promise<void> {
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

  // Asked once, out loud. Brissa holds one credential for reading history, and
  // whoever it belongs to is the only person `/translate` can serve — so the
  // process says whose it is at startup rather than leaving it to be inferred
  // from whose commands happen to work.
  const historyPorts =
    config.userToken === undefined
      ? {}
      : { history: createSlackHistory(config.userToken), historyOwner: await whoOwns(config.userToken) }

  if (config.userToken === undefined) {
    console.log('  /translate  off — no SLACK_USER_TOKEN, so no account to read a channel with')
  } else if (historyPorts.historyOwner === undefined) {
    console.log('  /translate  off — SLACK_USER_TOKEN was refused by Slack, so its owner is unknown')
  } else {
    console.log(`  /translate  reads history as ${historyPorts.historyOwner}, and only for them`)
  }

  // Enrolment survives a restart because it is a file, and on Fly a file only
  // survives if it is on a volume. Everything else Brissa knows — who has been
  // seen, what a channel's policy is — is still memory and still goes.
  const enrolment = createFileEnrolment(config.enrolmentPath)

  const connection = connectSocketMode({
    appToken: config.appToken,
    onStatus: (status) => console.log(`  ${status}`),
    // The half that needs no channel membership: somebody picks Brissa from a
    // message's "..." menu and the answer comes back only to them, in a channel
    // Brissa has never joined and cannot see.
    // `/translate`, which reads the channel as the person who typed it. Without
    // a user token there is nothing to read with, and the command says so rather
    // than failing quietly — the shortcut carries its own text and is unaffected.
    onCommand: (payload) => {
      // Slack delivers every slash command down the same frame, so which one it
      // is has to be read before anything else can be. Each module refuses a
      // command that is not its own, but routing here means `/brissa` never
      // spends a translation deciding it was not a translation.
      if (typeof (payload as { command?: unknown })?.command === 'string' &&
          (payload as { command: string }).command === ENROL_COMMAND) {
        const enrol = readEnrolCommand(payload)
        if (!enrol.ok) {
          console.log(`  /brissa refused: ${enrol.because}`)
          return
        }
        void handleEnrol({ enrolment }, enrol.command).then((outcome) => {
          console.log(`  ${enrol.command.teamId}  /brissa  ${outcome.kind}`)
        })
        return
      }

      const read = readCommand(payload)
      if (!read.ok) {
        console.log(`  command refused: ${read.because}`)
        // Answered when the payload said where to. Slack acknowledged the
        // command already, so a refusal that only reaches this terminal is a
        // command that silently did nothing.
        if (read.responseUrl !== undefined) void refuseCommand(read.responseUrl, read.because)
        return
      }
      void handleCommand({ ...work.ports, ...historyPorts }, read.command).then((outcome) => {
        const what = outcome.kind === 'noticed' ? `noticed:${outcome.notice}` : outcome.kind
        const why = 'detail' in outcome ? ` — ${outcome.detail}` : ''
        console.log(`  ${read.command.channelId}  /translate  ${what}${why}`)
      })
    },
    onInteractive: (payload) => {
      const read = readShortcut(payload)
      if (!read.ok) {
        console.log(`  shortcut ignored: ${read.because}`)
        return
      }
      void handleShortcut(work.ports, read.shortcut).then((outcome) => {
        const what = outcome.kind === 'noticed' ? `noticed:${outcome.notice}` : outcome.kind
        console.log(`  ${read.shortcut.channelId}  shortcut  ${what}`)
      })
    },
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
if (argv[1] !== undefined && import.meta.url === pathToFileURL(argv[1]).href) void main()
