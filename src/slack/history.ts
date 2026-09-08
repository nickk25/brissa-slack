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
 * So this reads with a USER token instead. Brissa reads as the person who
 * typed `/translate`, in channels they already belong to, and joins nothing.
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
        const query = new URLSearchParams({ channel: channelId, limit: String(limit) })
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

        const messages = (body.messages ?? [])
          .map(toRecentMessage)
          .filter((m): m is RecentMessage => m !== undefined)
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
