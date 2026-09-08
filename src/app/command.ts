/**
 * Somebody typed `/translate`. Answer them, and only them.
 *
 * Modelled closely on `shortcut.ts`: the same "it always answers" rule, the
 * same shape of ports, the same private answer through `response_url`. What
 * differs is where the text to translate comes from. A shortcut already has
 * it, in the payload Slack sent when somebody clicked a specific message; a
 * slash command has to go and ask for it, through `History`, using the one
 * credential that can read a channel Brissa is not a member of — the caller's
 * own user token. `docs/DECISIONS.md` records why the shortcut needed a
 * different door into the same room, and the reasoning is identical here:
 * reading through the bot token would require Brissa to join the channel
 * first, which is visible to everyone in it, including, in a Slack Connect
 * channel, the organisation on the other side.
 *
 * Like the shortcut, `shouldAsk` is not consulted. Somebody typing a command
 * has already answered every question it exists to ask on their behalf.
 */

import type { Directory } from '../core/directory.ts'
import type { History } from '../core/history.ts'
import { noticeText, renderNotice, renderTranslation, type Notice, type Source } from '../core/render.ts'
import type { Translator } from '../core/translator.ts'
import type { SlashCommand } from '../slack/command.ts'
import { replyPrivately } from '../slack/shortcut.ts'

/** The command this app owns. Anything else is not ours to answer. */
export const TRANSLATE_COMMAND = '/translate'

/**
 * How far back `/translate` with no argument looks for a message that is not
 * the caller's own.
 *
 * A small, fixed window rather than "keep paging until one is found": a
 * channel where the last ten messages are all the caller's own is one where
 * asking "what did I miss" has an honest answer — nothing yet — and searching
 * further only spends more of the caller's own user token rate limit chasing
 * a message that was never sent. The explicit-count path below has no such
 * limit because there the caller named the number themselves, and
 * `MAX_COUNT` in `src/slack/command.ts` already bounds it.
 */
const LATEST_WINDOW = 10

export interface CommandPorts {
  readonly directory: Directory
  readonly translator: Translator
  readonly history: History
  /** Injected so a test needs no network; the real one is `replyPrivately`. */
  readonly send?: typeof replyPrivately
}

export type CommandOutcome =
  | { readonly kind: 'translated'; readonly count: number }
  | { readonly kind: 'noticed'; readonly notice: Notice }
  | { readonly kind: 'not-ours'; readonly command: string }
  | { readonly kind: 'lookup-failed'; readonly detail: string }
  | { readonly kind: 'history-failed'; readonly detail: string }
  /** The answer itself did not arrive. Distinct from having nothing to say. */
  | { readonly kind: 'unanswerable'; readonly detail: string }

const detail = (err: unknown): string => String((err as Error)?.message ?? err)

/**
 * Which messages `/translate`'s argument points at, in the shape
 * `renderTranslation` already accepts — never the network itself.
 *
 * The one compromise worth naming: literal text has no author, because it was
 * never a message in the channel — it is attributed to whoever typed the
 * command, so the anchor `renderTranslation` always adds still has somewhere
 * honest to point.
 */
async function gatherSources(
  history: History,
  command: SlashCommand,
): Promise<{ readonly ok: true; readonly sources: readonly Source[] } | { readonly ok: false; readonly detail: string }> {
  const { argument } = command

  if (argument.kind === 'literal') {
    return { ok: true, sources: [{ authorId: command.invokedBy, text: argument.text }] }
  }

  const limit = argument.kind === 'count' ? argument.count : LATEST_WINDOW
  const read = await history.read(command.channelId, limit)
  if (!read.ok) return { ok: false, detail: read.detail }

  if (argument.kind === 'count') {
    // Oldest first: reading a handful of messages in the order they were said
    // is what makes them a conversation rather than a list. `history.read`
    // itself stays newest-first, matching Slack's own order.
    return { ok: true, sources: [...read.messages].reverse() }
  }

  // 'latest': the first message, newest first, that is not the caller's own.
  const found = read.messages.find((m) => m.authorId !== command.invokedBy)
  return { ok: true, sources: found ? [found] : [] }
}

/**
 * Who is asking, and what they read.
 *
 * The reader is looked up by **who typed the command**, never by who is in
 * the channel — the answer goes to one person by construction, the same
 * reasoning `handleShortcut` states for the same lookup.
 */
export async function handleCommand(ports: CommandPorts, command: SlashCommand): Promise<CommandOutcome> {
  if (command.command !== TRANSLATE_COMMAND) return { kind: 'not-ours', command: command.command }

  const send = ports.send ?? replyPrivately

  const answer = async (outcome: CommandOutcome, blocks: readonly unknown[], text: string) => {
    const replied = await send(command.responseUrl, { blocks, text })
    return replied.ok ? outcome : { kind: 'unanswerable' as const, detail: replied.detail }
  }

  const notice = (which: Notice) =>
    answer({ kind: 'noticed', notice: which }, renderNotice(which), noticeText(which))

  let reads: readonly string[]
  try {
    const view = await ports.directory.lookup(command.channelId)
    const reader = view.readers.find((r) => r.userId === command.invokedBy)
    if (!reader || reader.reads.length === 0) return await notice('nobody-knows-you')
    reads = reader.reads
  } catch (err) {
    return { kind: 'lookup-failed', detail: detail(err) }
  }

  const gathered = await gatherSources(ports.history, command)
  if (!gathered.ok) return { kind: 'history-failed', detail: gathered.detail }

  // Nothing to point at: an empty channel, or a caller who has only ever
  // talked to themselves. Still answered — a command that finds nothing is
  // not silence, it is a broken button. `already-readable` is the closest
  // existing notice and not a precise one: its wording says the message was
  // readable, when really there was no message at all. Reused anyway rather
  // than invented, because a new wording is a change to `renderNotice` and
  // this module does not own `src/core/render.ts`.
  if (gathered.sources.length === 0) return await notice('already-readable')

  const results = await Promise.all(
    gathered.sources.map(async (source) => {
      try {
        return { source, result: await ports.translator.translate({ text: source.text, reads }) }
      } catch {
        return { source, result: { kind: 'failed' as const, detail: 'threw' } }
      }
    }),
  )

  const translatedBlocks: unknown[] = []
  let translatedCount = 0
  let anyFailed = false
  for (const { source, result } of results) {
    if (result.kind === 'translated') {
      translatedBlocks.push(...renderTranslation(result.translation, source))
      translatedCount++
    } else if (result.kind === 'failed') {
      anyFailed = true
    }
    // 'silent' contributes nothing: that message was already readable.
  }

  if (translatedCount === 0) return await notice(anyFailed ? 'translation-failed' : 'already-readable')

  // A partial failure among several messages is still visible, never
  // swallowed — appended once rather than once per failed message, since what
  // the reader needs is "something was missed", not a count of how often.
  const blocks = anyFailed ? [...translatedBlocks, ...renderNotice('translation-failed')] : translatedBlocks
  const summary = `Translated ${translatedCount} message${translatedCount === 1 ? '' : 's'}.`
  const text = anyFailed ? `${summary} ${noticeText('translation-failed')}` : summary

  return await answer({ kind: 'translated', count: translatedCount }, blocks, text)
}
