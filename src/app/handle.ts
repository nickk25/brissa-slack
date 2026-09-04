/**
 * The one place every piece meets.
 *
 * Nothing here decides anything and nothing here knows a format. `receive`
 * understands Slack's payload, `shouldAsk` holds the product's judgement,
 * `renderTranslation` decides how a translation reads, `sendEphemeral` knows
 * what Slack accepts. This file only puts them in an order and awaits them, and
 * any line of it that starts to look like a rule belongs somewhere else.
 *
 * It is also the first module allowed to import from all of the others, which
 * makes it the first place a boundary can quietly stop existing. The check is
 * simple: if this file ever contains an `if` about the *content* of a message,
 * the rule it encodes was moved out of `src/core` and out of reach of the
 * corpus.
 */

import { shouldAsk } from '../core/ask.ts'
import type { Directory } from '../core/directory.ts'
import type { InboundMessage, Reader, SkipReason } from '../core/ports.ts'
import { renderTranslation } from '../core/render.ts'
import type { Translator } from '../core/translator.ts'
import { receive, type RejectReason, type SlackMessageEvent } from '../slack/receive.ts'
import { ephemeralFor, sendEphemeral, type SlackApi } from '../slack/send.ts'

/** The three answers this module needs from the outside world. */
export interface Ports {
  readonly directory: Directory
  readonly translator: Translator
  readonly slack: SlackApi
}

/**
 * What happened for one reader, in the vocabulary of whichever module produced
 * it.
 *
 * `stage` on a failure is load-bearing rather than decorative: a translate
 * failure is `src/llm`'s to fix and a send failure is `src/slack`'s. Same word,
 * two owners, and `send.ts` already insists on that distinction one level down.
 */
export type ReaderOutcome = { readonly userId: string } & (
  | { readonly kind: 'skipped'; readonly because: SkipReason }
  | { readonly kind: 'silent' }
  | { readonly kind: 'failed'; readonly stage: 'translate' | 'send'; readonly detail: string }
  | { readonly kind: 'delivered' }
  | {
      readonly kind: 'not-delivered'
      readonly because: 'reader-not-in-channel' | 'declined'
      readonly detail: string
    }
)

/**
 * What happened for one message.
 *
 * Two levels rather than a flat list, because a flat list makes an empty array
 * mean four different things: the event was not a message, the channel has
 * nobody enrolled, the lookup broke, or every reader was skipped. Those are the
 * same silence with four different owners, and collapsing them is the boolean
 * problem this codebase keeps refusing to have.
 *
 * `considered` carries at least one reader by construction: with none, the
 * answer is `nobody-to-tell`.
 */
export type MessageOutcome =
  | { readonly kind: 'rejected'; readonly because: RejectReason }
  | { readonly kind: 'nobody-to-tell' }
  | { readonly kind: 'lookup-failed'; readonly detail: string }
  | { readonly kind: 'considered'; readonly readers: readonly [ReaderOutcome, ...ReaderOutcome[]] }

const detail = (err: unknown): string => String((err as Error)?.message ?? err)

/**
 * Readers who want the same translation, keyed by the request that would be made
 * for them.
 *
 * `TranslationRequest` is `{ text, reads }` and carries no reader identity, so
 * two readers with the same `reads` produce a byte-identical request. Asking
 * twice pays twice and, worse, can return two different answers for one message
 * — a difference between two colleagues that no counter could ever explain.
 *
 * The key is the **ordered** tuple, not the set. `src/llm/decide.ts` takes
 * `reads[0]` as the language to translate into, so `['es','en']` and
 * `['en','es']` are different translations and must not share a call.
 */
const groupKey = (reader: Reader): string => JSON.stringify(reader.reads)

/** A group always has the reader that created it, so there is no empty case. */
type Group = readonly [Reader, ...Reader[]]

async function serveGroup(
  ports: Ports,
  message: InboundMessage,
  readers: Group,
  record: (outcome: ReaderOutcome) => void,
): Promise<void> {
  // Every reader in a group shares this by construction — that is what the
  // group is. Taking it from the first is only safe while the key is injective,
  // which is why `groupKey` serialises rather than joins: `['es en']` and
  // `['es','en']` join to the same string, and the loser of that collision would
  // be sent a translation into a language they never declared.
  const reads = readers[0].reads

  let result
  try {
    result = await ports.translator.translate({ text: message.text, reads })
  } catch (err) {
    // A port that throws is a port that failed. The translator this app ships
    // with returns `failed` instead, but a fake, a future adapter or a bug in
    // the SDK can still throw, and an unhandled rejection here would lose every
    // reader in the group with no record of why.
    for (const r of readers) record({ userId: r.userId, kind: 'failed', stage: 'translate', detail: detail(err) })
    return
  }

  if (result.kind === 'silent') {
    for (const r of readers) record({ userId: r.userId, kind: 'silent' })
    return
  }
  if (result.kind === 'failed') {
    for (const r of readers) record({ userId: r.userId, kind: 'failed', stage: 'translate', detail: result.detail })
    return
  }

  // Rendered once for the whole group. `renderTranslation` is pure over the
  // translation and knows nothing about who is reading it; only the send is per
  // person.
  const blocks = renderTranslation(result.translation)

  await Promise.all(
    readers.map(async (r) => {
      try {
        const sent = await sendEphemeral(ports.slack, ephemeralFor(message, r.userId, blocks, result.translation.text))
        record(
          sent.delivered
            ? { userId: r.userId, kind: 'delivered' }
            : { userId: r.userId, kind: 'not-delivered', because: sent.because, detail: sent.detail },
        )
      } catch (err) {
        record({ userId: r.userId, kind: 'failed', stage: 'send', detail: detail(err) })
      }
    }),
  )
}

/**
 * One Slack event, from arrival to whatever each reader ends up seeing.
 *
 * **This never rejects.** Every port call is wrapped and every failure comes back
 * as an outcome, because the caller is an HTTP handler that has to answer Slack
 * within seconds whatever happened. A thrown error there becomes a Slack retry,
 * which becomes a second copy of every ephemeral — precisely when something is
 * already wrong.
 *
 * Deduplicating those retries is **not** this function's job and cannot be: the
 * retry count and the event id live in the envelope, which `receive` never sees.
 * That belongs to whatever answers Slack's request. Called twice with the same
 * event, this honestly does the work twice.
 */
export async function handleMessage(ports: Ports, event: SlackMessageEvent): Promise<MessageOutcome> {
  const received = receive(event)
  if (!received.ok) return { kind: 'rejected', because: received.because }
  const message = received.message

  let view
  try {
    view = await ports.directory.lookup(message.channelId)
  } catch (err) {
    return { kind: 'lookup-failed', detail: detail(err) }
  }

  if (view.readers.length === 0) return { kind: 'nobody-to-tell' }

  const outcomes = new Map<string, ReaderOutcome>()
  const record = (outcome: ReaderOutcome) => void outcomes.set(outcome.userId, outcome)

  // Grouping happens strictly after `shouldAsk`, never before. A reader with no
  // declared languages would otherwise form a group whose request the translator
  // can only fail, turning a skip that has a reason into a failure that has a
  // stack — and the author of the message would never be excluded at all.
  const groups = new Map<string, [Reader, ...Reader[]]>()
  for (const reader of view.readers) {
    const decision = shouldAsk(message, reader, view.policy)
    if (!decision.ask) {
      record({ userId: reader.userId, kind: 'skipped', because: decision.because })
      continue
    }
    const key = groupKey(reader)
    const group = groups.get(key)
    if (group) group.push(reader)
    else groups.set(key, [reader])
  }

  // Wrapped here rather than only around each port call. `renderTranslation`
  // runs between two awaits and is not a port, so a malformed `Translation` from
  // any translator would otherwise escape as a rejected promise — the one thing
  // this function promises never to do.
  await Promise.all(
    [...groups.values()].map(async (readers) => {
      try {
        await serveGroup(ports, message, readers, record)
      } catch (err) {
        for (const r of readers) {
          if (!outcomes.has(r.userId)) {
            record({ userId: r.userId, kind: 'failed', stage: 'translate', detail: detail(err) })
          }
        }
      }
    }),
  )

  // Emitted in the order the directory gave, so the same message twice produces
  // the same list twice. An order that depended on which model call returned
  // first would make every assertion about this flaky.
  const ordered = view.readers.flatMap((r) => {
    const outcome = outcomes.get(r.userId)
    return outcome ? [outcome] : []
  })

  const [first, ...rest] = ordered
  if (first === undefined) return { kind: 'nobody-to-tell' }
  return { kind: 'considered', readers: [first, ...rest] }
}
