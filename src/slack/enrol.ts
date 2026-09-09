/**
 * The `/brissa` payload, and the three things its argument can mean.
 *
 * Mirrors `command.ts` exactly, down to the shape of the read: Slack's slash
 * command is a flat, form-encoded set of fields that has already been resolved
 * into a plain object by the time it reaches this module, and this file knows
 * nothing about the wire format — only the fields Slack documents for a slash
 * command: `command`, `text`, `team_id`, `user_id`, `response_url`.
 *
 * `text` stands in for three different requests, the same way `/translate`'s
 * does: nothing (show what Brissa currently thinks this person reads), the
 * word `off` (stop translating for them), or one or more language codes (set
 * what they read, in the order given). Parsing that here rather than in
 * `src/app` keeps the same rule the rest of this module states: what a Slack
 * field means is this file's job, and the only judgement `src/app` makes is
 * what to do with the result.
 */

import type { Language } from '../core/ports.ts'

/** What `/brissa`'s argument asks for. */
export type EnrolArgument =
  | { readonly kind: 'query' }
  | { readonly kind: 'off' }
  /** In the order given: `reads[0]` is the language a translation is made into. */
  | { readonly kind: 'set'; readonly reads: readonly Language[] }

/** One invocation of `/brissa`, in our own words. */
export interface EnrolCommand {
  /** Slack's own command string, e.g. `/brissa`. Whether it is ours to answer is `src/app`'s call, the same way `command` is for `/translate`. */
  readonly command: string
  /** The workspace this happened in. Every record is keyed by this alongside `invokedBy`, from the first line — see `src/core/enrolment.ts`. */
  readonly teamId: string
  /** The person who typed it, and the only person who will see the answer. */
  readonly invokedBy: string
  readonly argument: EnrolArgument
  /** Where the private answer goes. Same budget as `/translate`'s, documented in `RESPONSE_URL_BUDGET`. */
  readonly responseUrl: string
}

/** The parts of a slash command payload this reads. */
interface RawCommand {
  readonly command?: string
  readonly text?: string
  readonly team_id?: string
  readonly user_id?: string
  readonly response_url?: string
}

export type EnrolRead =
  | { readonly ok: true; readonly command: EnrolCommand }
  | {
      /**
       * Where to answer, when the payload said. A refusal the caller never
       * hears is the same as no answer at all, and Slack has already
       * acknowledged the command by the time this is read — the same
       * reasoning `readCommand` states for the same field.
       */
      readonly responseUrl?: string
      readonly ok: false
      readonly because: 'not-a-command' | 'no-response-url' | 'no-team' | 'no-user' | 'bad-language'
    }

type ArgumentRead =
  | { readonly ok: true; readonly argument: EnrolArgument }
  | { readonly ok: false; readonly because: 'bad-language' }

/**
 * A language token as somebody would actually type it: `es`, `ES`, `es-ES`.
 * The region, if any, is dropped rather than kept — `render.ts` names a
 * language from a two-letter code and nothing else, so keeping `es-es` on
 * file would silently turn into "shown rather than dropped" for a code that
 * was never really unknown, only spelled with a region nobody asked about.
 * What survives is checked against the *shape* every ISO 639-1 code has —
 * two letters — not against a fixed list of the languages Brissa happens to
 * name today: a code this file has never heard of is still a real language,
 * and refusing it here would refuse translations that would otherwise work.
 */
function parseLanguage(token: string): { readonly ok: true; readonly language: Language } | { readonly ok: false } {
  const primary = token.trim().toLowerCase().split('-')[0] ?? ''
  if (!/^[a-z]{2}$/.test(primary)) return { ok: false }
  return { ok: true, language: primary }
}

/**
 * Empty (or all whitespace) means "show me what you think I read", not an
 * error — the same silence-as-request convention `/translate`'s empty
 * argument follows. The single word `off`, in any case, means stop. Anything
 * else is read as one or more language codes, and a single bad one refuses
 * the whole line by name rather than quietly keeping the good ones — a
 * partly-applied `/brissa es xx fr` would leave the caller unsure which of
 * the three actually took.
 */
function parseArgument(text: string): ArgumentRead {
  const tokens = text.trim().split(/\s+/).filter(Boolean)

  if (tokens.length === 0) return { ok: true, argument: { kind: 'query' } }
  if (tokens.length === 1 && tokens[0]?.toLowerCase() === 'off') return { ok: true, argument: { kind: 'off' } }

  const reads: Language[] = []
  for (const token of tokens) {
    const parsed = parseLanguage(token)
    // Covers `off` typed alongside anything else, too: `off` is not a
    // two-letter code, so it fails the same check a nonsense language would,
    // rather than being silently read as one of two special forms.
    if (!parsed.ok) return { ok: false, because: 'bad-language' }
    reads.push(parsed.language)
  }
  return { ok: true, argument: { kind: 'set', reads } }
}

export function readEnrolCommand(payload: unknown): EnrolRead {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, because: 'not-a-command' }
  }
  const raw = payload as RawCommand

  // Without a response_url there is nowhere to answer, and answering is the
  // entire interaction — the same reasoning `readCommand` states for the
  // same field.
  if (!raw.response_url) return { ok: false, because: 'no-response-url' }
  const responseUrl = raw.response_url

  // Every refusal from here on carries somewhere to answer. Slack acknowledged
  // this command before any of it ran, so a refusal the caller cannot hear is
  // indistinguishable from a command that did nothing.
  if (!raw.team_id) return { ok: false, because: 'no-team', responseUrl }
  if (!raw.user_id) return { ok: false, because: 'no-user', responseUrl }

  const argument = parseArgument(raw.text ?? '')
  if (!argument.ok) return { ...argument, responseUrl }

  return {
    ok: true,
    command: {
      command: raw.command ?? '',
      teamId: raw.team_id,
      invokedBy: raw.user_id,
      argument: argument.argument,
      responseUrl: raw.response_url,
    },
  }
}
