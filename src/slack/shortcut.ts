/**
 * The message-menu shortcut: the half of this product that works everywhere.
 *
 * Two sentences in Slack's own documentation decide this, and both are quoted in
 * `send.ts`. `chat.postEphemeral` requires the app to be a **member of the
 * channel**, and it only reaches a reader who is **currently active**. So the
 * automatic path cannot exist without Brissa visibly joining a channel, and even
 * then it loses everything that arrives while nobody is looking.
 *
 * The shortcut has neither problem, and gets there by a different door:
 *
 *   "The `response_url` will bypass any channel posting permissions when used as
 *    a part of an app's action."
 *   "By default, a message published via `response_url` will be sent as an
 *    ephemeral message."
 *
 * No membership. No join message. Nothing in the member list. And in a Slack
 * Connect channel the other organisation cannot even see the shortcut exists —
 * "message actions are not shared; they are limited only to the team that has
 * installed the app". The reader is also, by definition, looking at Slack at the
 * moment they ask, which is the delivery condition the automatic path can only
 * hope for.
 *
 * What it costs is a click per message. That is the trade, and it is the right
 * way round.
 */

const RESPONSES = 5
const WINDOW_MINUTES = 30

/** What the app can do with one `response_url`, from Slack's documentation. */
export const RESPONSE_URL_BUDGET = { responses: RESPONSES, windowMinutes: WINDOW_MINUTES } as const

/** The parts of a `message_action` payload this reads. */
interface RawShortcut {
  readonly type?: string
  readonly callback_id?: string
  readonly response_url?: string
  readonly channel?: { readonly id?: string }
  readonly user?: { readonly id?: string }
  readonly message?: {
    readonly user?: string
    readonly bot_id?: string
    readonly text?: string
    readonly thread_ts?: string
    readonly ts?: string
  }
}

/**
 * One person asking for one message, in our own words.
 *
 * `invokedBy` and `authorId` are deliberately separate. On the automatic path
 * they being equal means "your own words back", and the message is skipped. Here
 * it means you asked to read your own message, which is a reasonable thing to
 * want and no reason to refuse.
 */
export interface Shortcut {
  readonly callbackId: string
  readonly channelId: string
  /** The person who clicked, and the only person who will see the answer. */
  readonly invokedBy: string
  readonly authorId: string
  readonly text: string
  readonly threadId?: string
  /** Where the private answer goes. Valid five times, for thirty minutes. */
  readonly responseUrl: string
}

export type ShortcutRead =
  | { readonly ok: true; readonly shortcut: Shortcut }
  | {
      readonly ok: false
      readonly because: 'not-a-shortcut' | 'no-response-url' | 'no-channel' | 'no-message' | 'no-text'
    }

export function readShortcut(payload: unknown): ShortcutRead {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, because: 'not-a-shortcut' }
  }
  const raw = payload as RawShortcut

  if (raw.type !== 'message_action') return { ok: false, because: 'not-a-shortcut' }

  // Without this there is nowhere to answer, and answering is the whole
  // interaction — a shortcut that cannot reply has done nothing at all.
  if (!raw.response_url) return { ok: false, because: 'no-response-url' }
  if (!raw.channel?.id) return { ok: false, because: 'no-channel' }
  if (!raw.user?.id) return { ok: false, because: 'no-message' }
  if (!raw.message) return { ok: false, because: 'no-message' }

  const text = raw.message.text ?? ''
  if (text.trim().length === 0) return { ok: false, because: 'no-text' }

  // A bot message carries `bot_id` and often no `user` at all. Unlike the
  // automatic path this is not a reason to refuse — somebody asked to read it —
  // but the answer still has to say who wrote it.
  const authorId = raw.message.user ?? raw.message.bot_id ?? 'unknown'

  return {
    ok: true,
    shortcut: {
      callbackId: raw.callback_id ?? '',
      channelId: raw.channel.id,
      invokedBy: raw.user.id,
      authorId,
      text,
      ...(raw.message.thread_ts !== undefined ? { threadId: raw.message.thread_ts } : {}),
      responseUrl: raw.response_url,
    },
  }
}

/** What `response_url` accepts, narrowed to what is sent. */
export interface ShortcutReply {
  /** Omitted rather than set: `ephemeral` is the default and the one we want. */
  readonly response_type?: 'ephemeral'
  readonly blocks: readonly unknown[]
  readonly text: string
  readonly replace_original?: false
}

export type Replied =
  | { readonly ok: true }
  | { readonly ok: false; readonly detail: string }

/**
 * Answer, privately, without being in the channel.
 *
 * `response_type` is left off deliberately: ephemeral is the documented default,
 * and naming it would invite somebody to change it to `in_channel` one day and
 * publish a colleague's translation to the room.
 */
export async function replyPrivately(
  responseUrl: string,
  reply: ShortcutReply,
  fetchImpl: typeof fetch = fetch,
): Promise<Replied> {
  try {
    const response = await fetchImpl(responseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(reply),
    })
    if (!response.ok) return { ok: false, detail: `http_${response.status}` }
    return { ok: true }
  } catch (err) {
    return { ok: false, detail: `transport: ${String((err as Error)?.message ?? err)}` }
  }
}
