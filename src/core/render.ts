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
 *
 * The one element that had to be added rather than removed is the anchor. An
 * ephemeral does not attach to the message it translates; it lands at the bottom
 * of the channel like any other message, only nobody else sees it. Two foreign
 * messages in a row therefore produce two translations and no way to tell which
 * is which, so each one names its author and quotes enough of the original to be
 * recognised.
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
export interface Source {
  /** The Slack id of whoever wrote the original. */
  readonly authorId: string
  /** The original message, in the language the reader could not read. */
  readonly text: string
}

/**
 * How much of the original is enough to recognise it.
 *
 * A glance, not a second copy of the message. Long enough that two messages in
 * a row are told apart by their opening words, short enough that the quote never
 * competes with the translation underneath it.
 */
const QUOTE_LIMIT = 80

/**
 * The original, collapsed to one line and cut to a glance.
 *
 * Escaped, which matters more here than anywhere else in this file: the original
 * is the one string in the product written by somebody else. A mention inside it
 * would otherwise render as a mention — and the whole point of the quote is that
 * it is evidence of what was said, not a re-broadcast of it.
 */
function quote(text: string): string {
  const oneLine = escapeMrkdwn(text.replace(/\s+/g, ' ').trim())
  return oneLine.length <= QUOTE_LIMIT ? oneLine : `${oneLine.slice(0, QUOTE_LIMIT - 1).trimEnd()}…`
}

/**
 * `source` is optional, and its absence is a real case rather than a shortcut.
 *
 * The anchor exists because an ephemeral lands at the bottom of a channel with
 * nothing tying it to the message it translates. Text a person just typed into a
 * slash command has no such problem — quoting it back to them under their own
 * name would be the app repeating what they said a second ago.
 */
export function renderTranslation(translation: Translation, source?: Source): readonly Block[] {
  const languages = translation.foundLanguages.map(name)
  const from =
    languages.length === 0
      ? 'Translated'
      : languages.length === 1
        ? `Translated from ${languages[0]}`
        : `Translated from ${languages.slice(0, -1).join(', ')} and ${languages.at(-1)}`

  // An ephemeral does not attach to the message it is about — it appears at the
  // bottom of the channel like any other message, only nobody else can see it.
  // With two foreign messages in a row that leaves two translations and no way
  // to tell which belongs to which, so the translation has to carry its own
  // anchor: who wrote it, and enough of their words to recognise.
  //
  // `<@U…>` is deliberately not escaped. Slack renders it as the person's
  // current display name, which is why this module needs no directory, no
  // `users:read` scope and no cache of names that go stale. In an ephemeral it
  // notifies nobody: the message is never delivered to the person named.
  const body =
    source === undefined
      ? escapeMrkdwn(translation.text)
      : `> <@${source.authorId}>: ${quote(source.text)}\n${escapeMrkdwn(translation.text)}`

  return [
    { type: 'section', text: { type: 'mrkdwn', text: body } },
    // Says which language this came from and that only this reader can see it.
    // Without the second half, a first-time reader's reasonable assumption is
    // that the whole channel just watched a bot translate a colleague for them.
    { type: 'context', elements: [{ type: 'mrkdwn', text: `${from} · only visible to you` }] },
  ]
}

/**
 * The short answers the shortcut gives when there is no translation to show.
 *
 * On the automatic path silence is the product: nothing appears and nothing
 * needs to be said. The shortcut inverts that. Somebody clicked, and a click
 * that produces nothing at all reads as broken — so every one of these is a case
 * where saying nothing would be worse than saying something small.
 */
export type Notice =
  | 'already-readable'
  | 'nothing-to-translate'
  | 'nobody-knows-you'
  | 'translation-failed'
  | 'not-your-account'
  | 'cannot-read-here'

const NOTICES: Record<Notice, string> = {
  // Deliberately not an apology. The reader asked, Brissa looked, and the answer
  // is that they can already read it — which is information, not a failure.
  'already-readable': 'Nothing to translate here — this is already in a language you read.',
  // Different from the line above, and the difference matters to whoever is
  // reading it: one says "you can read this", the other says "there was nothing
  // to read". Collapsing them would answer a question nobody asked.
  'nothing-to-translate': 'Nothing to translate — there are no messages here from anybody else.',
  'nobody-knows-you': 'Brissa does not know which languages you read yet, so it cannot tell what to translate.',
  'translation-failed': 'Could not translate that one. It is worth trying again.',
  // The honest version of a real limitation. Reading a channel needs somebody's
  // account, and right now Brissa holds exactly one — so for everybody else this
  // command would read as a colleague, which is not a thing to do quietly.
  'not-your-account':
    '`/translate` reads history with one person\'s account, and it is not yours. The message shortcut on any message works for everybody.',
  // Slack refused the read: a rate limit, an expired token, a channel that
  // account is not in. Named rather than swallowed, because from the outside it
  // is indistinguishable from Brissa being broken.
  'cannot-read-here': 'Could not read this channel. The shortcut on a single message still works.',
}

/** One line, only for the person who asked. */
export function renderNotice(notice: Notice): readonly Block[] {
  return [{ type: 'context', elements: [{ type: 'mrkdwn', text: NOTICES[notice] }] }]
}

/** The plain-text form of a notice, for clients that render no blocks. */
export function noticeText(notice: Notice): string {
  return NOTICES[notice]
}

