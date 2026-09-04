/**
 * Where "who reads what" comes from, while the answer still fits in memory.
 *
 * This module owns one question — the one `src/core/directory.ts` declares — and
 * today it answers it from a literal handed in at startup. That is the whole
 * implementation, and it is deliberately the whole implementation: a database
 * here would be schema, migrations and a connection pool serving a fact that
 * currently changes when one person edits one config file.
 *
 * What it must get right is not storage. It is the two rules the port states,
 * because they are the ones every later implementation will have to keep.
 */

import type { ChannelView, Directory } from '../core/directory.ts'
import type { ChannelPolicy, Reader } from '../core/ports.ts'

export interface DirectoryContents {
  /** Everyone who has told Brissa which languages they read. */
  readonly readers?: readonly Reader[]
  /** The channels somebody has made an explicit decision about. */
  readonly channels?: readonly ChannelPolicy[]
  /**
   * What a channel nobody has decided about is.
   *
   * A real product decision, named rather than buried. Brissa is sold as working
   * everywhere at once, which argues `enabled`; every other line of this
   * codebase argues that silence is the default and speaking is the exception.
   * Both are defensible and the code should not quietly pick one, so the caller
   * says which, and the default here is the quiet one.
   */
  readonly unknownChannels?: 'enabled' | 'disabled'
}

/**
 * Readers are not filtered by channel, and that is a known limitation rather
 * than an oversight.
 *
 * "Who reads what" is this module's fact. "Who is in this channel" is Slack's,
 * and per the repository's dependency rules only `src/slack` may ask it. So
 * every enrolled reader comes back for every channel, and Slack's own
 * `user_not_in_channel` is what removes the ones who are not there — an outcome
 * `src/slack/send.ts` already keeps distinct from a failure precisely so this
 * works.
 *
 * The cost is one send attempt per enrolled reader per translated message,
 * which is fine at one workspace and is not fine at a hundred. When it stops
 * being fine, the fix is a `Directory` implementation in `src/app` that composes
 * this module with a membership call — not a Slack import added here.
 */
export function createMemoryDirectory(contents: DirectoryContents = {}): Directory {
  const fallback = contents.unknownChannels === 'enabled'

  // Last one wins. A reader listed twice is a config typo, and returning them
  // twice would send the same person the same translation twice — a duplicate
  // that would look like a bug in the translator rather than in a list.
  const readers = [...new Map((contents.readers ?? []).map((r) => [r.userId, r])).values()]
  const policies = new Map((contents.channels ?? []).map((p) => [p.channelId, p]))

  return {
    async lookup(channelId: string): Promise<ChannelView> {
      const policy = policies.get(channelId) ?? { channelId, enabled: fallback }
      return { policy, readers }
    },
  }
}
