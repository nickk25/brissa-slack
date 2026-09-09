/**
 * Somebody typed `/brissa`. Answer them, and only them.
 *
 * Everything Brissa knew about who reads what used to be `BRISSA_READERS`, an
 * environment variable on somebody's laptop. Enrolling a new person meant
 * editing that file and restarting the process — which does not scale past one
 * person, and was the thing blocking the rest of the team from using Brissa at
 * all. `/brissa` is the self-service replacement: a person tells Brissa which
 * languages they read, Brissa writes it down, and says so.
 *
 * Modelled on `command.ts`: the same "it always answers" rule — a command that
 * produces nothing is a broken button — and the same shape of ports. What
 * differs is that this flow never asks `Directory` or `Translator` anything; it
 * asks `Enrolment`, and unlike every other port this module touches, it is
 * allowed to write. `src/core/enrolment.ts` states why that is acceptable for
 * this one port and not for `Directory`.
 */

import type { Enrolment, EnrolmentRecord } from '../core/enrolment.ts'
import { languageName } from '../core/render.ts'
import type { Language } from '../core/ports.ts'
import type { EnrolArgument, EnrolCommand } from '../slack/enrol.ts'
import { replyPrivately } from '../slack/shortcut.ts'

/** The command this app owns. Anything else is not ours to answer. */
export const ENROL_COMMAND = '/brissa'

export interface EnrolPorts {
  readonly enrolment: Enrolment
  /** Injected so a test needs no network; the real one is `replyPrivately`. */
  readonly send?: typeof replyPrivately
}

/** What a bare `/brissa` reports back, one of three genuinely different states. */
export type EnrolStatus =
  | { readonly kind: 'enrolled'; readonly reads: readonly Language[] }
  /** They were enrolled and ran `/brissa off`. Distinct from `never-enrolled` — see `EnrolmentRecord.reads`. */
  | { readonly kind: 'off' }
  | { readonly kind: 'never-enrolled' }

export type EnrolOutcome =
  | { readonly kind: 'reported'; readonly status: EnrolStatus }
  | { readonly kind: 'saved'; readonly reads: readonly Language[] }
  | { readonly kind: 'stopped' }
  | { readonly kind: 'not-ours'; readonly command: string }
  | { readonly kind: 'store-failed'; readonly detail: string }
  /** The answer itself did not arrive. Distinct from having nothing to say. */
  | { readonly kind: 'unanswerable'; readonly detail: string }

const detail = (err: unknown): string => String((err as Error)?.message ?? err)

/** The one shape every reply here takes: a single line, visible only to whoever asked. */
function line(text: string): readonly unknown[] {
  return [{ type: 'context', elements: [{ type: 'mrkdwn', text }] }]
}

/**
 * The languages, as a person would say them.
 *
 * Named rather than coded, and through the same mapping the context line under a
 * translation uses. Somebody who types `/brissa es en` and is answered "es, then
 * en" has been shown their own input back; being answered "Spanish, then
 * English" is Brissa saying what it understood.
 */
const describeReads = (reads: readonly Language[]): string => {
  const named = reads.map(languageName)
  return named.length === 1
    ? (named[0] ?? '')
    : `${named.slice(0, -1).join(', ')}, then ${named[named.length - 1]}`
}

/**
 * Tell somebody their command was refused before it ever became one.
 *
 * `readEnrolCommand` rejects a payload for reasons the caller can do something
 * about — a language that is not two letters, a missing team or user — and
 * Slack acknowledged the command before any of that ran. Without this, those
 * refusals reach a terminal the caller cannot see and `/brissa` appears to have
 * done nothing, which is indistinguishable from broken.
 */
export async function refuseEnrol(
  responseUrl: string,
  because: string,
  send: typeof replyPrivately = replyPrivately,
): Promise<void> {
  const text =
    because === 'bad-language'
      ? 'That did not look like a language. Use two-letter codes, e.g. `/brissa es en` — or `/brissa off` to stop translating for you.'
      : `That command could not be read: ${because}. Try \`/brissa\`, \`/brissa es en\`, or \`/brissa off\`.`
  await send(responseUrl, { blocks: line(text), text })
}

/**
 * Who is asking, and what they said.
 *
 * The person enrolled is **who typed the command**, never anybody else — the
 * same reasoning `handleCommand` states for the same lookup. There is nobody
 * else it could honestly be: enrolment is one person telling Brissa about
 * themselves, and there is no channel here to look members up in even if that
 * were the rule.
 */
export async function handleEnrol(ports: EnrolPorts, command: EnrolCommand): Promise<EnrolOutcome> {
  if (command.command !== ENROL_COMMAND) return { kind: 'not-ours', command: command.command }

  const send = ports.send ?? replyPrivately

  const answer = async (outcome: EnrolOutcome, text: string): Promise<EnrolOutcome> => {
    const replied = await send(command.responseUrl, { blocks: line(text), text })
    return replied.ok ? outcome : { kind: 'unanswerable', detail: replied.detail }
  }

  const argument: EnrolArgument = command.argument

  if (argument.kind === 'query') {
    let record: EnrolmentRecord | undefined
    try {
      record = await ports.enrolment.read(command.teamId, command.invokedBy)
    } catch (err) {
      return { kind: 'store-failed', detail: detail(err) }
    }

    if (record === undefined) {
      return await answer(
        { kind: 'reported', status: { kind: 'never-enrolled' } },
        'Brissa does not know which languages you read yet. Run `/brissa es en` — your languages, in the order you prefer them — to get started.',
      )
    }
    if (record.reads.length === 0) {
      return await answer(
        { kind: 'reported', status: { kind: 'off' } },
        'Brissa is not translating for you right now — you turned it off. Run `/brissa es en` to turn it back on.',
      )
    }
    return await answer(
      { kind: 'reported', status: { kind: 'enrolled', reads: record.reads } },
      `Brissa currently thinks you read: ${describeReads(record.reads)}.`,
    )
  }

  // 'off' and 'set' both come down to one write: off is a record whose `reads`
  // is empty, the same empty list `shouldAsk` already reads as "stay silent
  // for this reader" — no second code path for stopping.
  const reads: readonly Language[] = argument.kind === 'off' ? [] : argument.reads

  try {
    await ports.enrolment.write({ teamId: command.teamId, userId: command.invokedBy, reads })
  } catch (err) {
    return { kind: 'store-failed', detail: detail(err) }
  }

  if (argument.kind === 'off') {
    return await answer({ kind: 'stopped' }, 'Done — Brissa will stop translating for you until you run `/brissa` again.')
  }
  return await answer(
    { kind: 'saved', reads },
    `Saved. You read: ${describeReads(reads)}. Brissa will translate anything you do not already read into ${languageName(reads[0] ?? '')}.`,
  )
}
