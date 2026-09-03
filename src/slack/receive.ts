/**
 * Slack's shape, turned into ours.
 *
 * This is the whole reason the boundary exists. Slack's event payload is large,
 * loosely typed, and changes on Slack's schedule; `InboundMessage` is four fields
 * the core can reason about. Everything that knows what a Slack event looks like
 * has to stay on this side of the line, or the knowledge leaks into the logic and
 * the logic stops being testable without a network.
 *
 * Nothing here decides anything. The temptation is to filter here — the data is
 * right there — and that is exactly how an adapter fills up with `if`s about
 * message content and quietly becomes the place the product lives.
 */

import type { InboundMessage } from '../core/ports.ts'

/**
 * The parts of a Slack message event this adapter reads.
 *
 * Deliberately not Slack's own type: declaring the fields we depend on makes the
 * dependency visible and small, and an event carrying a hundred others is not a
 * reason to accept a hundred others.
 */
export interface SlackMessageEvent {
  readonly type?: string
  readonly subtype?: string
  readonly channel?: string
  readonly user?: string
  readonly bot_id?: string
  readonly text?: string
  readonly thread_ts?: string
  readonly ts?: string
}

/**
 * Why an event never became a message.
 *
 * Slack sends far more than messages down the same channel, and most of what it
 * sends is not one. Saying which kind it was keeps a silent drop distinguishable
 * from a bug.
 */
export type RejectReason = 'not-a-message' | 'no-text' | 'no-channel' | 'edited-or-special'

export type Received =
  | { readonly ok: true; readonly message: InboundMessage }
  | { readonly ok: false; readonly because: RejectReason }

/**
 * Subtypes that are not a person saying something.
 *
 * `message_changed` and `message_deleted` carry a nested payload with a different
 * shape entirely, and joins, leaves and channel topics are events about the
 * channel rather than messages in it. Translating any of them would be noise the
 * reader never asked for.
 */
const NOT_A_NEW_MESSAGE = new Set([
  'message_changed',
  'message_deleted',
  'channel_join',
  'channel_leave',
  'channel_topic',
  'channel_purpose',
  'channel_name',
  'thread_broadcast',
])

export function receive(event: SlackMessageEvent): Received {
  if (event.type !== 'message') return { ok: false, because: 'not-a-message' }
  if (event.subtype !== undefined && NOT_A_NEW_MESSAGE.has(event.subtype)) {
    return { ok: false, because: 'edited-or-special' }
  }
  if (!event.channel) return { ok: false, because: 'no-channel' }

  const text = event.text ?? ''
  if (text.trim().length === 0) return { ok: false, because: 'no-text' }

  // A bot message may carry `bot_id` with no `user` at all, so authorship has to
  // survive that: the core compares the author against the reader, and an empty
  // author would match nobody and be treated as somebody.
  const authorId = event.user ?? event.bot_id ?? 'unknown'

  const message: InboundMessage = {
    channelId: event.channel,
    authorId,
    // `bot_id` is present on every bot message including this app's own, which is
    // the loop this flag exists to break.
    fromBot: event.bot_id !== undefined,
    text,
    ...(event.thread_ts !== undefined ? { threadId: event.thread_ts } : {}),
  }

  return { ok: true, message }
}
