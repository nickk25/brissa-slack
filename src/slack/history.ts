/**
 * Reading a channel's recent messages, without Brissa ever joining it.
 *
 * `conversations.history` with a bot token answers `channel_not_found` unless
 * the app is a member of the channel — and joining one is visible to everyone
 * in it, including, in a Slack Connect channel, the external organisation.
 * That defeats the product for exactly the reason the shortcut exists (see
 * `src/slack/CLAUDE.md` and the shortcut entry in `docs/DECISIONS.md`): a
 * channel shared with a client is not a channel Brissa can afford to visibly
 * join.
 *
 * So this reads with a USER token instead, and joins nothing.
 *
 * **Whose token it is matters, and there is exactly one.** This adapter reads as
 * whoever authorised that credential — not as whoever typed the command. Letting
 * a second person's `/translate` read through it would put their request under
 * the owner's identity in Slack's access log, and the owner's memberships would
 * decide what the caller gets to see. `src/app/command.ts` refuses that by name
 * rather than doing it quietly, which is the only reason this adapter can stay
 * this simple.
 * Two things follow from that, and both are structural rather than a rule
 * this file has to remember to keep:
 *
 * - This is the only call in the product made with a user token, and it is
 *   also the only call this file *can* make — there is no second method here
 *   to post with it by mistake. Posting the translation back happens through
 *   `response_url`, a different credential entirely.
 * - It must never throw. A broken read is the caller's to answer for — "could
 *   not translate that one" — not an exception a slash command has no shape
 *   for.
 */

import type { History, HistoryRead, RecentMessage } from '../core/history.ts'

const ENDPOINT = 'https://slack.com/api/conversations.history'

/**
 * The most raw entries this will pull for one command.
 *
 * A ceiling on the surplus above, so a large `limit` cannot turn into a request
 * for Slack's entire page size. Slack's own maximum is 1000; this is far below
 * it because nobody reads twenty messages of translation, let alone a hundred.
 */
const MAX_FETCH = 60

/** The parts of one raw history entry this adapter reads. */
interface RawHistoryMessage {
  readonly subtype?: string
  readonly user?: string
  readonly bot_id?: string
  readonly text?: string
}

/**
 * Entries that are not a person saying something, mirroring `receive.ts`'s own
 * list for the same reason: a join, a leave or a topic change is an event
 * about the channel rather than a message in it, and translating one would be
 * noise nobody asked for.
 */
const NOT_A_MESSAGE = new Set([
  'channel_join',
  'channel_leave',
  'channel_topic',
  'channel_purpose',
  'channel_name',
  'thread_broadcast',
  'message_changed',
  'message_deleted',
])

function toRecentMessage(raw: RawHistoryMessage): RecentMessage | undefined {
  if (raw.subtype !== undefined && NOT_A_MESSAGE.has(raw.subtype)) return undefined

  const text = raw.text ?? ''
  if (text.trim().length === 0) return undefined

  // A bot message carries `bot_id` and often no `user` at all — the same
  // fallback `receive.ts` and `shortcut.ts` use, so an empty author never
  // silently matches whoever asked.
  const authorId = raw.user ?? raw.bot_id ?? 'unknown'
  return { authorId, text }
}

/**
 * @param userToken  the caller's own token, read-only in this code path.
 *                    Never sent anywhere else, and never used to post.
 * @param fetchImpl  injectable so a test needs no network; the real one is
 *                    `fetch`.
 */
export function createSlackHistory(userToken: string, fetchImpl: typeof fetch = fetch): History {
  return {
    async read(channelId: string, limit: number): Promise<HistoryRead> {
      try {
        // Asked for more than wanted, on purpose. Slack's `limit` counts raw
        // entries, and joins, topic changes and empty messages are filtered out
        // below — so asking for exactly N and then dropping three of them means
        // `/translate 5` quietly translates two. The surplus is trimmed after
        // filtering instead, which is where the count actually means something.
        const query = new URLSearchParams({
          channel: channelId,
          limit: String(Math.min(limit * 2 + 5, MAX_FETCH)),
        })
        const response = await fetchImpl(`${ENDPOINT}?${query.toString()}`, {
          // A read, and only ever a read: GET, no body. There is nothing in
          // this file that could turn this call into a post even by mistake.
          method: 'GET',
          headers: { authorization: `Bearer ${userToken}` },
        })

        // Slack answers 200 with `ok: false` for application errors, and a
        // non-200 for the ones that never reached the application — same
        // shape both `web.ts` and `shortcut.ts` already settle on.
        if (!response.ok) return { ok: false, detail: `http_${response.status}` }

        const body = (await response.json()) as {
          ok?: boolean
          error?: string
          messages?: readonly RawHistoryMessage[]
        }
        if (body.ok !== true) return { ok: false, detail: body.error ?? 'unknown' }

        // Trimmed here rather than by Slack: `limit` means "this many messages
        // a person actually wrote", which is the only reading of it that makes
        // `/translate 5` mean five.
        const messages = (body.messages ?? [])
          .map(toRecentMessage)
          .filter((m): m is RecentMessage => m !== undefined)
          .slice(0, limit)
        return { ok: true, messages }
      } catch (err) {
        // A DNS failure, a dropped socket, a body that is not JSON. Reported
        // as a refusal rather than thrown, because the caller's whole design
        // is that a translation which failed to appear must be visible as
        // such.
        return { ok: false, detail: `transport: ${String((err as Error)?.message ?? err)}` }
      }
    },
  }
}

/**
 * Whose account a token belongs to.
 *
 * Called once at startup so the process can say out loud whose history it is
 * able to read, and so `src/app/command.ts` can refuse anybody else. A
 * credential nobody checked the owner of is a credential nobody can be told
 * about, which is why an unanswerable check comes back as `undefined` rather
 * than as an optimistic guess.
 */
export async function whoOwns(userToken: string, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  try {
    const response = await fetchImpl('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: { authorization: `Bearer ${userToken}` },
    })
    if (!response.ok) return undefined
    const body = (await response.json()) as { ok?: boolean; user_id?: string }
    return body.ok === true ? body.user_id : undefined
  } catch {
    return undefined
  }
}
