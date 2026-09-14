/**
 * The `/say` payload: text somebody wrote, and the language they need it in.
 *
 * The opposite direction from everything else here. `/translate` and the
 * shortcut turn a message you cannot read into one you can; this turns
 * something you wrote into something the other side can read. Same shape of
 * payload, same rules about answering, opposite arrow.
 *
 * **The delimiter is not decoration, and it is the whole reason this file is
 * careful.** The obvious syntax is `/say de Hola qué tal` — language first,
 * bare. It cannot work for a Spanish writer. `de`, `en`, `es`, `no`, `se`,
 * `si`, `la`, `lo`, `el`, `te`, `su`, `mi` are all real ISO 639-1 codes *and*
 * among the commonest words a Spanish sentence opens with.
 *
 * The dangerous case is not `/say no puedo ir`, which would come back as
 * Norwegian and be visibly wrong. It is this:
 *
 *     /say de verdad que no llego
 *
 * The language reads as German — which is very likely what they wanted — and
 * the text silently becomes `verdad que no llego`. What comes back is fluent,
 * plausible German of a sentence they did not write, and it is about to be
 * pasted to a client. Nothing about it looks wrong.
 *
 * So the language must carry a shape no sentence starts with, and `de:` is
 * that shape. A missing one is refused by name rather than guessed at: this
 * module would rather ask again than truncate somebody's sentence.
 *
 * `src/slack/command.ts` already settled this principle for `/translate`,
 * where a leading token is a count only when the whole argument is the count.
 * This is the same rule, met by a different road.
 */

import type { Language } from '../core/ports.ts'
import { parseLanguage } from './enrol.ts'

/** One invocation of `/say`, in our own words. */
export interface SayCommand {
  /** Slack's own command string. Whether it is ours to answer is `src/app`'s call. */
  readonly command: string
  readonly teamId: string
  /** The person who typed it, and the only person who will see the answer. */
  readonly invokedBy: string
  /** The language they need it in — the recipient's, not theirs. */
  readonly into: Language
  /** What they wrote, verbatim. */
  readonly text: string
  /** Where the private answer goes. Same budget as `/translate`'s. */
  readonly responseUrl: string
}

export type SayRead =
  | { readonly ok: true; readonly command: SayCommand }
  | {
      /** Where to answer, when the payload said. A refusal nobody hears is no answer. */
      readonly responseUrl?: string
      readonly ok: false
      readonly because: 'not-a-command' | 'no-response-url' | 'no-team' | 'no-user' | 'no-language' | 'no-text'
    }

/** The parts of a slash command payload this reads. */
interface RawCommand {
  readonly command?: string
  readonly text?: string
  readonly team_id?: string
  readonly user_id?: string
  readonly response_url?: string
}

type ArgumentRead =
  | { readonly ok: true; readonly into: Language; readonly text: string }
  | { readonly ok: false; readonly because: 'no-language' | 'no-text' }

/**
 * `de: text`, and nothing looser.
 *
 * The code is matched by shape rather than against a list of languages Brissa
 * happens to name — the same reasoning `parseLanguage` states, and the same
 * function, so the two can never drift into disagreeing about what `de-AT`
 * means. Only the first colon is consumed: a sentence is allowed to contain
 * as many more as it likes.
 */
function parseArgument(raw: string): ArgumentRead {
  const trimmed = raw.trim()
  const at = trimmed.indexOf(':')
  if (at === -1) return { ok: false, because: 'no-language' }

  const parsed = parseLanguage(trimmed.slice(0, at))
  if (!parsed.ok) return { ok: false, because: 'no-language' }

  // A language with nothing after it is a person who stopped halfway, not a
  // request to translate the empty string.
  const text = trimmed.slice(at + 1).trim()
  if (text.length === 0) return { ok: false, because: 'no-text' }

  return { ok: true, into: parsed.language, text }
}

export function readSayCommand(payload: unknown): SayRead {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, because: 'not-a-command' }
  }
  const raw = payload as RawCommand

  if (!raw.response_url) return { ok: false, because: 'no-response-url' }
  const responseUrl = raw.response_url

  // Every refusal from here on carries somewhere to answer, for the reason
  // `readEnrolCommand` states: Slack acknowledged this before any of it ran.
  if (!raw.team_id) return { ok: false, because: 'no-team', responseUrl }
  if (!raw.user_id) return { ok: false, because: 'no-user', responseUrl }

  const argument = parseArgument(raw.text ?? '')
  if (!argument.ok) return { ok: false, because: argument.because, responseUrl }

  return {
    ok: true,
    command: {
      command: raw.command ?? '',
      teamId: raw.team_id,
      invokedBy: raw.user_id,
      into: argument.into,
      text: argument.text,
      responseUrl,
    },
  }
}
