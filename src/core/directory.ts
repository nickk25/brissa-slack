/**
 * The port the core asks "who reads what here" through.
 *
 * Declared alongside `translator.ts` and for the same reason: the core owns the
 * shape of the question, and an interface declared in the module that answers it
 * lets that module's vocabulary — a table name, a row, a cache — cross back one
 * field at a time.
 *
 * No function in `src/core` takes a `Directory`. The core is asked a question
 * about data it was handed; `src/app` is what does the handing. The moment a
 * core function accepts a port so it can be "tested properly", the core has a
 * clock.
 */

import type { ChannelPolicy, Reader } from './ports.ts'

/**
 * Everything Brissa needs to know about one channel, read at one instant.
 *
 * One value rather than two lookups on purpose. The policy and the readers are
 * always wanted together, by the same caller, about the same channel — and two
 * calls are two observations of a state that can disagree between them once this
 * is a database rather than a literal.
 */
export interface ChannelView {
  readonly policy: ChannelPolicy
  /** Everyone Brissa translates for here. Empty when it knows nobody. */
  readonly readers: readonly Reader[]
}

/**
 * Read-only, and that is the design rather than an omission.
 *
 * Enrolment — somebody telling Brissa which languages they read — is the store's
 * own business and never something the core asks for. The core asks; it does not
 * tell. A port with a write method on it is a port that will grow a transaction.
 *
 * An unknown channel must come back disabled, never absent. Silence is this
 * product's normal behaviour, so "we have never heard of this channel" and "we
 * were switched off here" should produce the same thing, and only one of them
 * needs the caller to remember to check for undefined.
 */
export interface Directory {
  lookup(channelId: string): Promise<ChannelView>
}
