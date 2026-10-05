/**
 * Somebody typed `/say de: …`. Turn what they wrote into what the other side reads.
 *
 * The mirror of `shortcut.ts`, and deliberately the smaller of the two. That one
 * asks the directory who is reading and what they can already read; this one is
 * told the target outright, because the person who needs the German is not in
 * this workspace and never will be. So there is no `Directory` here, and that
 * absence is the design rather than an omission: `/say` serves somebody who has
 * never run `/brissa`, and asking a directory about them would refuse the one
 * command that needs nothing from it.
 *
 * **No new prompt.** `decide.md` takes the languages the reader reads and
 * translates into the first of them; called with the recipient's language it
 * translates into exactly that. The reader is the recipient — which is what
 * `Translator.reads` has always meant, only in the other direction. An
 * adversarial review caught me about to write a second prompt, a second corpus
 * and a second evaluation to say a thing the first one already said.
 *
 * **Nothing is sent.** Everything here answers through `response_url` and there
 * is no path from this file to posting anywhere. That is what makes the name
 * `/say` a small lie and `renderOutbound`'s line the correction.
 */

import { noticeText, renderNotice, renderOutbound, type Notice } from '../core/render.ts'
import type { Translator } from '../core/translator.ts'
import { fallbackText } from '../slack/send.ts'
import type { SayCommand } from '../slack/say.ts'
import { replyPrivately } from '../slack/shortcut.ts'

/** The command this app owns. Anything else is not ours to answer. */
export const SAY_COMMAND = '/say'

export interface SayPorts {
  readonly translator: Translator
  /** Injected so a test needs no network; the real one is `replyPrivately`. */
  readonly send?: typeof replyPrivately
}

export type SayOutcome =
  | { readonly kind: 'said'; readonly into: string }
  /** What they wrote already reads as the language they asked for. */
  | { readonly kind: 'unchanged'; readonly into: string }
  | { readonly kind: 'noticed'; readonly notice: Notice }
  | { readonly kind: 'not-ours'; readonly command: string }
  /** The answer itself did not arrive. Distinct from having nothing to say. */
  | { readonly kind: 'unanswerable'; readonly detail: string }

/** The one shape a refusal takes: a single line, visible only to whoever asked. */
const line = (text: string): readonly unknown[] => [{ type: 'context', elements: [{ type: 'mrkdwn', text }] }]

/**
 * A payload the parser would not read, answered anyway.
 *
 * Slack acknowledged the command before any of this ran, so a refusal that only
 * reaches the process is a command that silently did nothing. `no-language` gets
 * its own sentence because it is not a typo — it is the commonest way to use
 * this command wrong, and the fix is one character.
 */
export async function refuseSay(
  responseUrl: string,
  because: string,
  send: typeof replyPrivately = replyPrivately,
): Promise<void> {
  const text =
    because === 'no-language'
      ? 'Say which language, with a colon: `/say de: Can we move the meeting to Tuesday?` — without it Brissa cannot tell the language from the first word of your sentence.'
      : because === 'no-text'
        ? 'That was a language with nothing after it. Try `/say de: Can we move the meeting to Tuesday?`'
        : `That command could not be read: ${because}. Try \`/say de: Can we move the meeting to Tuesday?\``
  await send(responseUrl, { blocks: line(text), text })
}

export async function handleSay(ports: SayPorts, command: SayCommand): Promise<SayOutcome> {
  if (command.command !== SAY_COMMAND) return { kind: 'not-ours', command: command.command }

  const send = ports.send ?? replyPrivately

  const answer = async (outcome: SayOutcome, blocks: readonly unknown[], text: string): Promise<SayOutcome> => {
    const replied = await send(command.responseUrl, { blocks, text })
    return replied.ok ? outcome : { kind: 'unanswerable' as const, detail: replied.detail }
  }

  let result
  try {
    result = await ports.translator.translate({ text: command.text, reads: [command.into] })
  } catch {
    return await answer({ kind: 'noticed', notice: 'translation-failed' }, renderNotice('translation-failed'), noticeText('translation-failed'))
  }

  if (result.kind === 'failed') {
    return await answer({ kind: 'noticed', notice: 'translation-failed' }, renderNotice('translation-failed'), noticeText('translation-failed'))
  }

  // Silence is the right answer to "does this need translating" and the wrong
  // answer to somebody who asked for something to paste. They get their own
  // words back, with a line saying why they are unchanged — so there is always
  // something to copy, which is the entire point of the command.
  if (result.kind === 'silent') {
    const blocks = renderOutbound(command.text, command.into, true)
    return await answer({ kind: 'unchanged', into: command.into }, blocks, fallbackText(command.text))
  }

  const blocks = renderOutbound(result.translation.text, command.into)
  return await answer({ kind: 'said', into: command.into }, blocks, fallbackText(result.translation.text))
}
