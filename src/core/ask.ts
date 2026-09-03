/**
 * Should we ask the model about this message at all?
 *
 * Every message in every enabled channel passes through here, and most of them
 * stop. That is the point twice over: silence is the product, and a message that
 * never reaches the model costs nothing.
 *
 * What this deliberately does **not** do is guess at languages. Deciding whether
 * a message contains something the reader cannot read is the model's job,
 * because real messages mix languages inside a single sentence and every
 * heuristic that tries to shortcut it is wrong in the direction that matters —
 * staying quiet about the message that mattered. The rules below are only the
 * ones that need no language knowledge at all.
 */

import type { AskDecision, ChannelPolicy, InboundMessage, Reader } from './ports.ts'

/**
 * Text with nothing a translation could act on.
 *
 * A bare link, a lone emoji, a mention with no words: there is no sentence here
 * for any language to be in, so asking would spend a model call to be told what
 * the shape of the message already says.
 */
export function hasNothingToRead(text: string): boolean {
  const stripped = text
    .replace(/```[\s\S]*?```/g, ' ') // fenced code
    .replace(/`[^`]*`/g, ' ') // inline code
    .replace(/<[^>]*>/g, ' ') // Slack links, mentions, channel refs
    .replace(/:[a-z0-9_+-]+:/gi, ' ') // emoji shortcodes
    .replace(/https?:\/\/\S+/g, ' ') // bare urls
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, ' ')
    .replace(/[^\p{Letter}\p{Number}]/gu, ' ')
    .trim()

  // One character is a reaction, not a sentence. Two is the shortest word a
  // language has, and `ok` is exactly the case that made this a two rather than
  // a one.
  return stripped.length < 2
}

/**
 * @param message  the message as it arrived
 * @param reader   the person we would be translating for
 * @param policy   what Brissa may do in this channel
 */
export function shouldAsk(message: InboundMessage, reader: Reader, policy: ChannelPolicy): AskDecision {
  if (!policy.enabled) return { ask: false, because: 'channel-disabled' }

  // Brissa's own output is a message in the channel like any other. Without this
  // it would translate itself, and then translate that.
  if (message.fromBot) return { ask: false, because: 'from-a-bot' }

  // Nobody needs their own words back. This is also the cheapest guard against
  // a channel where the reader is the one writing in the foreign language.
  if (message.authorId === reader.userId) return { ask: false, because: 'own-message' }

  // A reader who has declared no languages has not finished setting up. Treating
  // that as "reads nothing, translate everything" would make the loudest
  // possible first impression.
  if (reader.reads.length === 0) return { ask: false, because: 'reader-reads-nothing' }

  if (hasNothingToRead(message.text)) return { ask: false, because: 'nothing-to-read' }

  return { ask: true }
}
