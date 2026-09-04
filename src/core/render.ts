/**
 * What the reader actually sees.
 *
 * Pure, and worth keeping that way even though it produces something shaped like
 * a Slack payload: how a translation reads is a product decision, and product
 * decisions that live in an adapter are product decisions nobody tests.
 *
 * The whole design pressure here is downward. This appears unprompted, under
 * somebody else's message, in a channel shared with a client. Every element
 * earns its place or it is noise attached to something the reader did want.
 */

/** A finished translation, before it is anything Slack understands. */
export interface Translation {
  /** The whole message in the reader's language. */
  readonly text: string
  /** The languages found that the reader does not read. ISO 639-1. */
  readonly foundLanguages: readonly string[]
}

/**
 * A Slack Block Kit block, narrowed to what is used here.
 *
 * Declared rather than imported for the same reason `SlackMessageEvent` is: the
 * shape we depend on should be visible and small, and this file must stay free
 * of the SDK so it can be tested without one.
 */
export type Block =
  | { readonly type: 'section'; readonly text: { readonly type: 'mrkdwn'; readonly text: string } }
  | { readonly type: 'context'; readonly elements: readonly { readonly type: 'mrkdwn'; readonly text: string }[] }

const LANGUAGE_NAMES: Record<string, string> = { de: 'German', es: 'Spanish', en: 'English', fr: 'French', it: 'Italian', nl: 'Dutch', pt: 'Portuguese' }

const name = (code: string) => LANGUAGE_NAMES[code] ?? code

/**
 * Slack renders `mrkdwn` inside a section, so a translated message containing
 * the characters Slack uses for formatting would be re-formatted — a stray
 * asterisk in the original becoming bold in the translation. Escaping only the
 * three characters Slack treats as markup keeps everything else intact.
 */
export function escapeMrkdwn(text: string): string {
  return text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c)
}

/**
 * The blocks for one translation.
 *
 * A section carrying the message, and one line of context saying where it came
 * from. No header, no divider, no button: this sits underneath a message the
 * reader is already looking at, and anything that makes it look like a separate
 * announcement makes the channel worse.
 */
export function renderTranslation(translation: Translation): readonly Block[] {
  const languages = translation.foundLanguages.map(name)
  const from =
    languages.length === 0
      ? 'Translated'
      : languages.length === 1
        ? `Translated from ${languages[0]}`
        : `Translated from ${languages.slice(0, -1).join(', ')} and ${languages.at(-1)}`

  return [
    { type: 'section', text: { type: 'mrkdwn', text: escapeMrkdwn(translation.text) } },
    // Says who is speaking and that only this reader can see it. Without the
    // second half, a first-time reader's reasonable assumption is that the whole
    // channel just watched a bot translate a colleague for them.
    { type: 'context', elements: [{ type: 'mrkdwn', text: `${from} · only visible to you` }] },
  ]
}
