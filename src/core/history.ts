/**
 * The port `/translate` asks "what was said here recently" through.
 *
 * Declared alongside `directory.ts` and `translator.ts`, for the same reason:
 * deciding which of several recent messages to act on — skip the caller's own,
 * take the last N, or none of that when the argument was already literal text
 * — is a judgement the half of this system reasoned about without a network
 * should own. An interface declared in the adapter that answers it —
 * `src/slack/history.ts` — would let a Slack response shape, a pagination
 * cursor, a rate-limit header cross back one field at a time.
 *
 * Read-only, and that is a structural fact rather than a convention this file
 * has to remember to honour: there is exactly one method, and nothing here
 * declares a counterpart that writes. `/translate` only ever looks at a
 * channel; posting the translation back happens through `response_url`, a
 * different credential entirely, held by `src/slack/shortcut.ts`, not by
 * whatever implements this port. See `src/slack/CLAUDE.md` for why reading
 * needs its own token in the first place — the same reasoning the shortcut
 * entry in `docs/DECISIONS.md` already recorded for a different door into the
 * same problem.
 *
 * Every implementation of this must never throw. A read that failed is data
 * the caller answers for — "could not translate that one" — never an
 * exception that turns a slash command into a stack trace three awaits later.
 */

/** One message, stripped to what a translation needs and nothing else. */
export interface RecentMessage {
  readonly authorId: string
  readonly text: string
}

/**
 * A read, or the reason it did not produce one.
 *
 * Kept apart from a bare `readonly RecentMessage[]` for the same reason
 * `TranslationResult` is three variants rather than two: an empty channel and
 * a broken connection to Slack must not collapse into the same empty array,
 * or a real outage reads as "nobody has said anything here yet."
 */
export type HistoryRead =
  | { readonly ok: true; readonly messages: readonly RecentMessage[] }
  | { readonly ok: false; readonly detail: string }

export interface History {
  /**
   * The most recent `limit` messages in `channelId`, newest first — the same
   * order Slack's own `conversations.history` returns, so nothing downstream
   * has to re-sort what Slack already sorted.
   */
  read(channelId: string, limit: number): Promise<HistoryRead>
}
