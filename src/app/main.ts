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
import { replyPrivately } from '../slack/shortcut.ts'
import { createSlackHistory, whoOwns } from '../slack/history.ts'
import { readShortcut } from '../slack/shortcut.ts'
import { noticeText, renderNotice } from '../core/render.ts'
import { createSlackApi } from '../slack/web.ts'
import { createFileDirectory, createFileEnrolment } from '../store/enrolment.ts'
import { createFileTokens, TokenStoreUnreadable } from '../store/tokens.ts'
import { createMemorySeen } from '../store/seen.ts'
import { readConfig } from './config.ts'
import { handleCommand, refuseCommand } from './command.ts'
import { ENROL_COMMAND, handleEnrol } from './enrol.ts'
import { completeConnection, connectUrl, disconnect, forgetIfDead, type ConnectPorts } from './connect.ts'
import { startServer } from './server.ts'
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
      // Who reads what comes from the file people write to with `/brissa`, and
      // from nowhere else. It used to come from `BRISSA_READERS`, read once at
      // boot — so enrolling wrote a record nothing consulted, and the command
      // and the behaviour could each be right about a different fact.
      directory: createFileDirectory(config.enrolmentPath, {
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
  // Counted from the file rather than listed from the environment. Naming
  // people here was only possible while the list was a variable somebody typed;
  // now it is a fact they write themselves, and a banner that printed a stale
  // copy of it is how the old bug hid in plain sight for a day.
  // Counted through the very directory every message will use, rather than
  // listed from the environment. Naming people here was only possible while the
  // list was a variable somebody typed; it is now a fact they write themselves,
  // and a banner printing a stale copy of it is how the old bug stayed hidden.
  //
  // Asking the real port also means an enrolment file this cannot read is found
  // at startup instead of by the first person who writes something.
  try {
    const { readers } = await work.ports.directory.lookup('startup-check')
    const enrolled = readers.filter((r) => r.reads.length > 0).length
    const off = readers.length - enrolled
    console.log(
      readers.length === 0
        ? '  readers   nobody yet — anyone can run `/brissa es` to enrol themselves'
        : `  readers   ${enrolled} enrolled${off > 0 ? `, ${off} switched off` : ''}`,
    )
  } catch (err) {
    console.error(`  readers   UNREADABLE — ${String((err as Error)?.message ?? err)}`)
    console.error('            every message will fail this way until the file is readable or removed')
  }
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
  const tokens = config.tokensKey === '' ? undefined : createFileTokens(config.tokensPath, config.tokensKey)

  // Absent is a working state, and the whole flow is off rather than half on.
  // `readConfig` already refuses a partial configuration for the same reason: a
  // link built from an id with no secret behind it walks somebody through
  // Slack's consent screen to a callback that cannot complete.
  // Opened once, here, so a key that does not match the file is a refusal to
  // start with a sentence somebody can act on — rather than every `/translate`
  // from everybody failing quietly, one request at a time, behind a log line
  // that says `Error`. `write` and `forget` read the file first, so a mismatch
  // wedges the store completely; that is worth finding out at 09:00 and not at
  // the first person who tries to use it.
  if (tokens !== undefined) {
    try {
      await tokens.read('startup', 'check')
    } catch (err) {
      if (err instanceof TokenStoreUnreadable) {
        console.error(`Brissa cannot start: ${err.message}`)
        console.error('\nEither restore the BRISSA_TOKENS_KEY that wrote it, or delete the file and have')
        console.error('everybody run `/brissa connect` again. Nothing in it is recoverable without the key,')
        console.error('which is the point of encrypting it.')
        process.exitCode = 1
        return
      }
      throw err
    }
  }

  const connecting: ConnectPorts | undefined =
    config.oauth === undefined
      ? undefined
      : tokens === undefined
        ? undefined
        : {
          config: {
            clientId: config.oauth.clientId,
            clientSecret: config.oauth.clientSecret,
            redirectUri: `${config.oauth.publicUrl}/oauth/callback`,
            // The same secret that proves a request came from Slack now also
            // signs the state that binds one person's flow to them. One secret
            // with two uses, rather than a second one nobody remembers to set.
            stateSecret: config.signingSecret,
          },
          tokens,
        }

  if (connecting === undefined) {
    console.log('  /brissa connect  off — SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, BRISSA_PUBLIC_URL, SLACK_SIGNING_SECRET and BRISSA_TOKENS_KEY are needed together')
  } else {
    const running = await startServer(
      {
        // Nothing starts a flow here: a browser at a public URL carries no
        // Slack identity, so `/brissa connect` mints the link instead.
        start: () => ({ location: 'https://slack.com' }),
        callback: async (query) => {
          const done = await completeConnection(connecting, query)
          // The detail when there is one, because `refused:exchange-failed`
          // alone cannot tell a mistyped redirect URL from a Slack outage, and
          // those want opposite reactions. It is a closed word from Slack, not
          // anything off the request.
          const why = done.kind === 'connected' ? 'connected' : `refused:${done.because}${done.detail === undefined ? '' : ` (${done.detail})`}`
          console.log(`  oauth callback  ${why}`)
          return done.kind === 'connected'
            ? { status: 200, body: 'Connected. You can close this tab and go back to Slack.' }
            : { status: 400, body: 'That did not work. Go back to Slack and run /brissa connect again.' }
        },
      },
      config.port,
    )
    console.log(`  listening    on ${config.port} for /oauth/callback and /healthz`)
    process.once('SIGTERM', () => void running.close())
  }

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
        // `connect` and `disconnect` are about a credential, not a preference,
        // so they are answered here where the credential work is reachable.
        const arg = enrol.command.argument
        if (arg.kind === 'connect' || arg.kind === 'disconnect') {
          const who = { teamId: enrol.command.teamId, userId: enrol.command.invokedBy }
          void (async () => {
            if (connecting === undefined) {
              await replyPrivately(enrol.command.responseUrl, {
                blocks: [],
                text: 'Connecting your own account is not set up on this installation yet.',
              })
              return
            }
            if (arg.kind === 'connect') {
              // Handed back privately: a link with somebody's identity signed
              // into it is not a link to paste in a channel.
              const handed = await replyPrivately(enrol.command.responseUrl, {
                blocks: [],
                text: `Authorise Brissa to read channels as you: ${connectUrl(connecting, who)}\n\nOnly you can see this link, and only you can use it.`,
              })
              // Reported on what happened rather than on what was attempted: a
              // link that never arrived is a person staring at nothing.
              console.log(`  ${who.teamId}  /brissa connect  ${handed.ok ? 'link issued' : `unanswerable: ${handed.detail}`}`)
              return
            }
            const gone = await disconnect(connecting, who)
            await replyPrivately(enrol.command.responseUrl, {
              blocks: [],
              text: gone.revokedAtSlack
                ? 'Disconnected. Brissa has forgotten your token and Slack has revoked it.'
                : 'Disconnected. Brissa has forgotten your token; Slack would not confirm the revocation, so check Apps in your Slack settings.',
            })
            console.log(`  ${who.teamId}  /brissa disconnect  revokedAtSlack=${gone.revokedAtSlack}`)
          })().catch((err: unknown) => {
            // `tokens.read` throws on a corrupt or unreadable file. Without this
            // the first `/brissa connect` after that would take the process — and
            // Brissa's websocket — down with it.
            console.error(`  /brissa ${arg.kind} failed: ${String((err as Error)?.name ?? 'error')}`)
          })
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
      void (async () => {
        // Whoever typed it, read as themselves. The single configured token is
        // only a fallback for the person it belongs to — everybody else brings
        // their own through `/brissa connect`, and until they do they are
        // refused by name rather than served with somebody else's access.
        // No store at all means OAuth is off, and the configured token is the
        // only one there is — the state Brissa ran in before any of this.
        const mine = tokens === undefined ? undefined : await tokens.read(read.command.teamId, read.command.invokedBy)
        const theirs =
          mine === undefined
            ? historyPorts
            : { history: createSlackHistory(mine.token), historyOwner: read.command.invokedBy }

        const outcome = await handleCommand({ ...work.ports, ...theirs }, read.command)

        // Slack has stopped honouring this person's token — revoked from their
        // own settings, or expired. Dropped here rather than left on disk, so
        // the next `/translate` tells them to reconnect instead of repeating a
        // read failure that will never clear on its own.
        if (outcome.kind === 'history-failed' && connecting !== undefined && mine !== undefined) {
          const dropped = await forgetIfDead(connecting, { teamId: read.command.teamId, userId: read.command.invokedBy }, outcome.detail)
          if (dropped) {
            await replyPrivately(read.command.responseUrl, {
              blocks: renderNotice('reconnect-needed'),
              text: noticeText('reconnect-needed'),
            })
            console.log(`  ${read.command.channelId}  /translate  credential dropped: ${outcome.detail}`)
            return
          }
        }
        const what = outcome.kind === 'noticed' ? `noticed:${outcome.notice}` : outcome.kind
        const why = 'detail' in outcome ? ` — ${outcome.detail}` : ''
        console.log(`  ${read.command.channelId}  /translate  ${what}${why}`)
      })().catch((err: unknown) => {
        // A `tokens.json` nobody can read must break `/translate`, not the
        // process every translation arrives through.
        //
        // The name only, except for the one error whose message is safe by
        // construction: `TokenStoreUnreadable` names a path and nothing else,
        // and it is precisely the message an operator needs. Every other error
        // on this path came near a live user token.
        const said = err instanceof TokenStoreUnreadable ? err.message : String((err as Error)?.name ?? 'error')
        console.error(`  /translate failed: ${said}`)
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
            // The other first-run state, and the one that is now reachable in a
            // way it never used to be: the channel is on and nobody has enrolled.
            // Before, that meant somebody had forgotten a variable; now it means
            // nobody has run `/brissa` yet, which is the honest first state of
            // every install and worth naming rather than leaving as silence.
            if (outcome.kind === 'nobody-to-tell') {
              console.log('            nobody has run `/brissa` yet — until somebody does, there is no one to translate for')
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
