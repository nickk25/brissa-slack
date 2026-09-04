/**
 * Putting a translation in front of one reader, and nobody else.
 *
 * Slack has exactly one way to show a message to a single person in a channel:
 * `chat.postEphemeral`. It carries a limitation that shapes the whole product,
 * so it is stated here rather than discovered later — **Slack only delivers an
 * ephemeral message if the reader is currently in the channel.** Someone opening
 * Slack to forty overnight messages gets none of them.
 *
 * That is why a private shortcut on the message menu is not a nice-to-have. This
 * path covers what arrives while the reader is present; the shortcut covers the
 * rest, and neither is sufficient alone.
 */

import type { Block } from '../core/render.ts'

/** What `chat.postEphemeral` needs, and nothing more. */
export interface EphemeralRequest {
  readonly channel: string
  /** The one person who will see it. */
  readonly user: string
  readonly blocks: readonly Block[]
  /** Falls back into the notification and any client that cannot render blocks. */
  readonly text: string
  /** Present only for a reply, so the translation lands in the same thread. */
  readonly thread_ts?: string
}

/** The subset of the Slack client this module uses. */
export interface SlackApi {
  postEphemeral(request: EphemeralRequest): Promise<{ readonly ok: boolean; readonly error?: string }>
}

export type SendOutcome =
  | { readonly delivered: true }
  | { readonly delivered: false; readonly because: 'reader-not-in-channel' | 'declined'; readonly detail: string }

/**
 * Slack's way of saying the reader was not there to see it.
 *
 * Not an error in any useful sense — it is the expected answer for a message
 * that arrived overnight — but it must not be mistaken for success either, or
 * the state page would report translations nobody ever saw.
 */
const NOT_PRESENT = new Set(['user_not_in_channel', 'channel_not_found', 'user_not_found'])

/**
 * @param api      the Slack client, narrowed to one method
 * @param request  who sees what, and where
 */
export async function sendEphemeral(api: SlackApi, request: EphemeralRequest): Promise<SendOutcome> {
  const response = await api.postEphemeral(request)

  if (response.ok) return { delivered: true }

  const error = response.error ?? 'unknown'
  if (NOT_PRESENT.has(error)) {
    return { delivered: false, because: 'reader-not-in-channel', detail: error }
  }

  // Anything else is a real refusal — a bad token, a missing scope, a malformed
  // block. Returned rather than thrown, and never swallowed: a translation that
  // silently failed to appear is indistinguishable, to the reader, from a
  // message Brissa decided not to translate.
  return { delivered: false, because: 'declined', detail: error }
}

/**
 * The plain-text fallback that rides alongside the blocks.
 *
 * Slack uses it for the notification and for any client that cannot render
 * blocks, and omitting it means a push notification reading "This content can't
 * be displayed". Truncated because a notification is a glance, not the message.
 */
export function fallbackText(translated: string, limit = 120): string {
  const oneLine = translated.replace(/\s+/g, ' ').trim()
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit - 1).trimEnd()}…`
}
