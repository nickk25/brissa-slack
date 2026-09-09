/**
 * The slash command's payload, and the three things its argument can mean.
 *
 * Slack sends a slash command as a flat set of fields, form-encoded rather
 * than the JSON the interactivity payload arrives as — but by the time it
 * reaches this module that distinction has already been resolved into a plain
 * object, the same way `readShortcut` is handed already-parsed JSON. This file
 * knows nothing about the wire format; it only knows the fields Slack
 * documents for a slash command: `command`, `text`, `channel_id`, `user_id`,
 * `response_url`.
 *
 * The interesting part is `text`, which is one string standing in for three
 * different requests: nothing (translate the most recent message that is not
 * the caller's own), a small integer (translate the last N messages), or
 * anything else (translate that literal text). Parsing it here rather than in
 * `src/app` keeps the same rule this repository states everywhere else: what
 * a Slack field means is this module's job, and the only judgement `src/app`
 * makes is what to do with the result.
 */

/**
 * How far `/translate N` is allowed to reach back.
 *
 * Not Slack's limit — Slack's own page size for `conversations.history` is far
 * larger than this. The ceiling is here because every message the command
 * finds is translated and rendered into one private reply: past a couple of
 * dozen sections that reply stops being something a person glances at and
 * becomes something they scroll, which is the opposite of what an ephemeral
 * answer is for. Refused rather than silently clamped, so asking for 200
 * messages gets an answer that says so instead of quietly becoming 20.
 */
export const MAX_COUNT = 20

/** What `/translate`'s argument asks for. */
export type Argument =
  | { readonly kind: 'latest' }
  | { readonly kind: 'count'; readonly count: number }
  | { readonly kind: 'literal'; readonly text: string }

/** One invocation of `/translate`, in our own words. */
export interface SlashCommand {
  /** Slack's own command string, e.g. `/translate`. Whether it is ours to answer is `src/app`'s call, the same way `callbackId` is for the shortcut. */
  readonly command: string
  readonly channelId: string
  /**
   * The workspace it came from.
   *
   * Carried because a token is keyed by `(teamId, userId)` and a user id alone
   * is not unique across workspaces — the day Brissa is installed in two, a
   * key without this would hand one person another's credential.
   */
  readonly teamId: string
  /** The person who typed it, and the only person who will see the answer. */
  readonly invokedBy: string
  readonly argument: Argument
  /** Where the private answer goes. Valid five times, for thirty minutes — the same budget the shortcut documents in `RESPONSE_URL_BUDGET`. */
  readonly responseUrl: string
}

/** The parts of a slash command payload this reads. */
interface RawCommand {
  readonly team_id?: string
  readonly command?: string
  readonly text?: string
  readonly channel_id?: string
  readonly user_id?: string
  readonly response_url?: string
}

export type CommandRead =
  | { readonly ok: true; readonly command: SlashCommand }
  | {
      /**
       * Where to answer, when the payload said. A refusal the caller never hears
       * is the same as no answer at all, and Slack has already acknowledged the
       * command by the time this is read.
       */
      readonly responseUrl?: string
      readonly ok: false
      readonly because:
        | 'not-a-command'
        | 'no-response-url'
        | 'no-channel'
        | 'no-user'
        | 'no-team'
        | 'count-zero'
        | 'count-too-large'
    }

type ArgumentRead =
  | { readonly ok: true; readonly argument: Argument }
  | { readonly ok: false; readonly because: 'count-zero' | 'count-too-large' }

/**
 * Empty text means the most recent message, not an error — silence in the
 * argument is a request, the same way silence is the product everywhere else
 * in Brissa. A string of digits and nothing else means a count. Everything
 * else is literal text, verbatim: `/translate 5 people showed up` is not a
 * count of five, it is a sentence that happens to start with a digit.
 */
function parseArgument(text: string): ArgumentRead {
  const trimmed = text.trim()

  if (trimmed.length === 0) return { ok: true, argument: { kind: 'latest' } }

  if (/^\d+$/.test(trimmed)) {
    const count = Number(trimmed)
    // Zero is not a small count, it is nothing to do — the same shape of
    // refusal as an absurdly large one, so both are named rather than one
    // being silently reinterpreted as literal text.
    if (count === 0) return { ok: false, because: 'count-zero' }
    if (count > MAX_COUNT) return { ok: false, because: 'count-too-large' }
    return { ok: true, argument: { kind: 'count', count } }
  }

  return { ok: true, argument: { kind: 'literal', text: trimmed } }
}

export function readCommand(payload: unknown): CommandRead {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, because: 'not-a-command' }
  }
  const raw = payload as RawCommand

  // Without a response_url there is nowhere to answer, and answering is the
  // entire interaction — the same reasoning `readShortcut` states for the
  // same field.
  if (!raw.response_url) return { ok: false, because: 'no-response-url' }
  const responseUrl = raw.response_url

  // Every refusal from here on carries somewhere to answer. Slack acknowledged
  // this command before any of it ran, so a refusal the caller cannot hear is
  // indistinguishable from a command that did nothing.
  if (!raw.channel_id) return { ok: false, because: 'no-channel', responseUrl }
  if (!raw.user_id) return { ok: false, because: 'no-user', responseUrl }
  // Refused rather than defaulted. A token is keyed by `(teamId, userId)`, and
  // an empty team would file everybody from every workspace under one blank
  // key — `readEnrolCommand` already refuses this and the two must agree.
  if (!raw.team_id) return { ok: false, because: 'no-team', responseUrl }

  const argument = parseArgument(raw.text ?? '')
  // Carried down from the argument parser, which never saw the payload: a
  // refusal the caller cannot hear is the same as no answer at all, and Slack
  // acknowledged this command before any of it ran.
  if (!argument.ok) return { ...argument, responseUrl }

  return {
    ok: true,
    command: {
      command: raw.command ?? '',
      channelId: raw.channel_id,
      teamId: raw.team_id,
      invokedBy: raw.user_id,
      argument: argument.argument,
      responseUrl: raw.response_url,
    },
  }
}
