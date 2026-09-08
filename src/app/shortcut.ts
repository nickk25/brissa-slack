/**
 * Somebody asked. Answer them.
 *
 * This is the same pipeline as `handle.ts` with one rule removed and one added,
 * and both changes come from the same fact: **the reader asked for this**.
 *
 * Removed: `shouldAsk`. Every rule in it exists to decide whether a translation
 * is worth appearing unprompted — is the channel on, is this a bot, is it your
 * own message, is there anything to read. A person who clicked has answered all
 * of those, and re-asking them would mean refusing a request on the grounds that
 * nobody requested it. The channel policy in particular must not apply: the
 * whole point of the shortcut is that it works in channels Brissa is not in.
 *
 * Added: **it always answers.** On the automatic path silence is the product. A
 * click that produces nothing is a broken button.
 */

import type { Directory } from '../core/directory.ts'
import { noticeText, renderNotice, renderTranslation, type Notice } from '../core/render.ts'
import type { Translator } from '../core/translator.ts'
import { fallbackText } from '../slack/send.ts'
import { replyPrivately, type Shortcut } from '../slack/shortcut.ts'

/** The shortcut this app owns. Anything else is not ours to answer. */
export const TRANSLATE = 'translate_message'

export interface ShortcutPorts {
  readonly directory: Directory
  readonly translator: Translator
  /** Injected so a test needs no network; the real one is `fetch`. */
  readonly send?: typeof replyPrivately
}

export type ShortcutOutcome =
  | { readonly kind: 'translated' }
  | { readonly kind: 'noticed'; readonly notice: Notice }
  | { readonly kind: 'not-ours'; readonly callbackId: string }
  | { readonly kind: 'lookup-failed'; readonly detail: string }
  /** The answer itself did not arrive. Distinct from having nothing to say. */
  | { readonly kind: 'unanswerable'; readonly detail: string }

const detail = (err: unknown): string => String((err as Error)?.message ?? err)

/**
 * Who is asking, and what they read.
 *
 * The directory is asked about the channel the message is in, which is a channel
 * Brissa may well not belong to — that is fine, it only ever holds facts about
 * people. The reader is looked up by **who clicked**, not by who is in the
 * channel, because the shortcut is addressed to one person by construction.
 */
export async function handleShortcut(ports: ShortcutPorts, shortcut: Shortcut): Promise<ShortcutOutcome> {
  if (shortcut.callbackId !== TRANSLATE) return { kind: 'not-ours', callbackId: shortcut.callbackId }

  const send = ports.send ?? replyPrivately

  const answer = async (outcome: ShortcutOutcome, blocks: readonly unknown[], text: string) => {
    const replied = await send(shortcut.responseUrl, { blocks, text })
    return replied.ok ? outcome : { kind: 'unanswerable' as const, detail: replied.detail }
  }

  const notice = (which: Notice) =>
    answer({ kind: 'noticed', notice: which }, renderNotice(which), noticeText(which))

  let reads: readonly string[]
  try {
    const view = await ports.directory.lookup(shortcut.channelId)
    const reader = view.readers.find((r) => r.userId === shortcut.invokedBy)
    // Not an error and not silence: somebody clicked a button and deserves to be
    // told why nothing happened, in terms they can act on.
    if (!reader || reader.reads.length === 0) return await notice('nobody-knows-you')
    reads = reader.reads
  } catch (err) {
    return { kind: 'lookup-failed', detail: detail(err) }
  }

  let result
  try {
    result = await ports.translator.translate({ text: shortcut.text, reads })
  } catch {
    // A port that throws is a port that failed, and the reader is waiting on a
    // click. Told the same thing as any other failure: something to try again.
    return await notice('translation-failed')
  }

  if (result.kind === 'silent') return await notice('already-readable')
  if (result.kind === 'failed') return await notice('translation-failed')

  const blocks = renderTranslation(result.translation, {
    authorId: shortcut.authorId,
    text: shortcut.text,
  })
  return await answer({ kind: 'translated' }, blocks, fallbackText(result.translation.text))
}
