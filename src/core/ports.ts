/**
 * The shapes the core speaks in.
 *
 * Everything here is data. No adapter type, no SDK type, and nothing that knows
 * what Slack or a model call looks like — the core is the half of this system
 * that can be reasoned about without a network, and that only stays true if the
 * boundary is described in its own words.
 */

/** A language the reader either reads or does not. ISO 639-1. */
export type Language = string

/** What a person has told Brissa about themselves. */
export interface Reader {
  readonly userId: string
  /**
   * The languages this person **reads**, not the ones they speak.
   *
   * The distinction is the product: someone who reads English fluently but
   * writes in Spanish needs nothing translated from English. Asking what
   * somebody speaks would translate far more than they need.
   */
  readonly reads: readonly Language[]
}

/** A message as it arrived, stripped of everything the core has no use for. */
export interface InboundMessage {
  readonly channelId: string
  readonly authorId: string
  /** True when the author is any bot, this one included. */
  readonly fromBot: boolean
  readonly text: string
  /** Present when the message is a reply. */
  readonly threadId?: string
}

/** What Brissa is allowed to do in one channel. */
export interface ChannelPolicy {
  readonly channelId: string
  readonly enabled: boolean
}

/**
 * Why the core decided not to ask the model.
 *
 * A reason rather than a boolean, because "we stayed silent" is the most common
 * outcome by design and an unexplained silence is indistinguishable from a bug.
 * Every one of these ends up on the state page as a counter.
 */
export type SkipReason =
  | 'channel-disabled'
  | 'from-a-bot'
  | 'own-message'
  | 'reader-reads-nothing'
  | 'nothing-to-read'

export type AskDecision =
  | { readonly ask: true }
  | { readonly ask: false; readonly because: SkipReason }
