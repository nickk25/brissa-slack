import assert from 'node:assert/strict'
import { test } from 'node:test'
import { escapeKeepingReferences, escapeMrkdwn, noticeText, renderNotice, renderOutbound, renderTranslation } from './render.ts'
import type { Source } from './render.ts'

const JENS: Source = { authorId: 'U-jens', text: 'Passt bei mir auch!' }

const section = (blocks: readonly ReturnType<typeof renderTranslation>[number][]) =>
  blocks.find((b) => b.type === 'section')
const context = (blocks: readonly ReturnType<typeof renderTranslation>[number][]) =>
  blocks.find((b) => b.type === 'context')

test('INV-core-10 a translation renders as the message and one line of context', () => {
  // It sits underneath a message the reader is already looking at. A header or a
  // divider would make it read as a separate announcement.
  const blocks = renderTranslation({ text: 'Me viene bien.', foundLanguages: ['de'] }, JENS)
  assert.equal(blocks.length, 2)
  assert.equal(section(blocks)?.type, 'section')
  assert.equal(context(blocks)?.type, 'context')
})

test('INV-core-11 the context says the message is visible to nobody else', () => {
  // Without it, a first-time reader's reasonable assumption is that the whole
  // channel just watched a bot translate a colleague for them.
  const blocks = renderTranslation({ text: 'x', foundLanguages: ['de'] }, JENS)
  const c = context(blocks)
  assert.ok(c?.type === 'context' && /only visible to you/i.test(c.elements[0]?.text ?? ''))
})

test('INV-core-12 languages are named, not printed as codes', () => {
  const blocks = renderTranslation({ text: 'x', foundLanguages: ['de'] }, JENS)
  const c = context(blocks)
  assert.ok(c?.type === 'context' && c.elements[0]?.text.includes('German'))
})

test('INV-core-13 several languages read as a list rather than a join', () => {
  const blocks = renderTranslation({ text: 'x', foundLanguages: ['de', 'fr', 'nl'] }, JENS)
  const c = context(blocks)
  assert.ok(c?.type === 'context' && /German, French and Dutch/.test(c.elements[0]?.text ?? ''))
})

test('INV-core-14 an unknown language code is shown rather than dropped', () => {
  // Losing it would leave "Translated" with no source at all, which reads as a
  // bug rather than as a language nobody named yet.
  const blocks = renderTranslation({ text: 'x', foundLanguages: ['zz'] }, JENS)
  const c = context(blocks)
  assert.ok(c?.type === 'context' && c.elements[0]?.text.includes('zz'))
})

test('INV-core-15 the translated text is escaped so Slack cannot re-format it', () => {
  // A stray angle bracket in the original would otherwise become markup in the
  // translation — the message changing shape on its way to the reader.
  const blocks = renderTranslation({ text: 'a < b & c > d', foundLanguages: ['de'] }, JENS)
  const s = section(blocks)
  // The anchor comes first; the translation is the line under it.
  assert.ok(s?.type === 'section' && s.text.text.endsWith('\na &lt; b &amp; c &gt; d'))
})

test('INV-core-16 escaping leaves ordinary text untouched', () => {
  assert.equal(escapeMrkdwn('Passt bei mir auch! 👍 https://example.test/x'), 'Passt bei mir auch! 👍 https://example.test/x')
})

test('INV-core-17 the translation says who wrote the original', () => {
  // As a mention, not a name: Slack renders it as the person's current display
  // name, so this module needs no directory, no `users:read` scope, and no cache
  // of names that go stale the day somebody marries.
  const blocks = renderTranslation({ text: 'Me viene bien.', foundLanguages: ['de'] }, JENS)
  const s = section(blocks)
  assert.ok(s?.type === 'section' && s.text.text.startsWith('> <@U-jens>: '))
})

test('INV-core-18 two messages in a row stay told apart', () => {
  // The reason any of this exists. An ephemeral does not attach to the message
  // it translates — it lands at the bottom of the channel — so two foreign
  // messages produce two translations that would otherwise be interchangeable.
  const first = renderTranslation(
    { text: 'A mí también me viene bien.', foundLanguages: ['de'] },
    { authorId: 'U-jens', text: 'Passt bei mir auch!' },
  )
  const second = renderTranslation(
    { text: 'Necesitamos las cifras el viernes.', foundLanguages: ['de'] },
    { authorId: 'U-klaus', text: 'Wir brauchen die Zahlen bis Freitag.' },
  )
  const a = section(first)
  const b = section(second)
  assert.ok(a?.type === 'section' && b?.type === 'section')
  assert.ok(a.text.text.includes('Passt bei mir auch!'))
  assert.ok(b.text.text.includes('Wir brauchen die Zahlen bis Freitag.'))
  assert.notEqual(a.text.text, b.text.text)
})

test('INV-core-19 a long original is a glance, not a second copy of the message', () => {
  // The quote is there to be recognised, not read. Repeating the whole message
  // above its own translation doubles the height of something that appears
  // unprompted in somebody else's channel.
  const long = 'Wir brauchen die Zahlen bis Freitag, sonst verschiebt sich alles um eine Woche nach hinten.'
  const blocks = renderTranslation({ text: 'x', foundLanguages: ['de'] }, { authorId: 'U-klaus', text: long })
  const s = section(blocks)
  assert.ok(s?.type === 'section')
  const quoted = s.text.text.split('\n')[0] ?? ''
  assert.ok(quoted.endsWith('…'))
  assert.ok(quoted.startsWith('> <@U-klaus>: Wir brauchen die Zahlen'))
  // The end of the original is gone. Length alone would not say this: the
  // mention prefix makes the quoted line longer than the message it trims.
  assert.ok(!quoted.includes('nach hinten'))
})

test('INV-core-20 a mention in the quoted original shows as the person it names', () => {
  // A reader recognises a message by who it was addressed to, and the raw id
  // `<@U0APEL2PG2C>` tells them nothing. Everything Brissa sends is ephemeral,
  // so a live mention in the quote is seen by the reader alone and notifies
  // nobody — exactly as in the translation underneath it.
  const blocks = renderTranslation(
    { text: 'Hecho.', foundLanguages: ['de'] },
    { authorId: 'U-jens', text: 'Fertig <@U-ana>, danke! <b>nicht fett</b>' },
  )
  const s = section(blocks)
  assert.ok(s?.type === 'section')
  assert.ok(s.text.text.startsWith('> <@U-jens>: '), 'the author still comes first')
  assert.ok(s.text.text.includes('Fertig <@U-ana>,'), 'the mention stays a mention')
  // Text that only looks like markup is still inert.
  assert.ok(s.text.text.includes('&lt;b&gt;nicht fett&lt;/b&gt;'))
})

test('INV-core-21 a multi-line original is quoted as one line', () => {
  // Slack's `>` quotes to the end of the line. A newline inside the quote would
  // put the rest of the original outside the quote bar, where it reads as the
  // translation.
  const blocks = renderTranslation(
    { text: 'Hola a todos.', foundLanguages: ['de'] },
    { authorId: 'U-jens', text: '  Hallo\n\n   zusammen.  ' },
  )
  const s = section(blocks)
  assert.ok(s?.type === 'section')
  assert.equal(s.text.text.split('\n')[0], '> <@U-jens>: Hallo zusammen.')
})

test('INV-core-22 the quote is cut at a fixed length, and a message exactly that long is not cut', () => {
  // Two off-by-ones live here and neither is visible in a screenshot: whether
  // the boundary is inside or outside, and whether the ellipsis replaces a
  // character or is added to them.
  const quoteOf = (text: string) => {
    const blocks = renderTranslation({ text: 'x', foundLanguages: ['de'] }, { authorId: 'U-k', text })
    const s = section(blocks)
    assert.ok(s?.type === 'section')
    return (s.text.text.split('\n')[0] ?? '').replace('> <@U-k>: ', '')
  }

  const exact = 'a'.repeat(80)
  assert.equal(quoteOf(exact), exact)

  // One character more, and what comes back is the same width, not one wider:
  // the ellipsis takes a character's place rather than being appended to it.
  const over = quoteOf('b'.repeat(81))
  assert.equal(over.length, 80)
  assert.ok(over.endsWith('…'))

  // And the cut never leaves a space hanging in front of the ellipsis.
  assert.equal(quoteOf(`${'c'.repeat(78)} dddddd`), `${'c'.repeat(78)}…`)
})

test('INV-core-23 a translation whose source language is unknown still says it was translated', () => {
  // The model may return no languages at all. Without this branch the context
  // line would read "Translated from " and trail off, which looks like the bug
  // it is not.
  const blocks = renderTranslation({ text: 'Me viene bien.', foundLanguages: [] }, JENS)
  const c = context(blocks)
  assert.ok(c?.type === 'context')
  assert.equal(c.elements[0]?.text, 'Translated · only visible to you')
})

test('INV-core-24 every notice is one line, and none of them apologises', () => {
  // These only ever appear because somebody clicked and there was no translation
  // to show. Silence would read as a broken button; a paragraph would read as an
  // incident. One line, and "you can already read this" is information rather
  // than a failure.
  for (const notice of ['already-readable', 'nothing-to-translate', 'nobody-knows-you', 'translation-failed', 'not-your-account', 'reconnect-needed', 'cannot-read-here'] as const) {
    const blocks = renderNotice(notice)
    assert.equal(blocks.length, 1)
    const c = context(blocks)
    assert.ok(c?.type === 'context')
    assert.equal(c.elements[0]?.text, noticeText(notice))
    assert.ok(!c.elements[0]?.text.includes('\n'))
    assert.ok(!/sorry|apolog/i.test(c.elements[0]?.text ?? ''))
  }
})

test('INV-core-25 a translation with no source to point at carries no anchor', () => {
  // The anchor disambiguates one ephemeral from another at the bottom of a
  // channel. Text somebody typed into a command a second ago needs no such help,
  // and quoting them back under their own name is the app repeating them.
  const blocks = renderTranslation({ text: 'Buenos días a todos.', foundLanguages: ['de'] })
  const s = section(blocks)
  assert.ok(s?.type === 'section')
  assert.equal(s.text.text, 'Buenos días a todos.')
  assert.ok(!s.text.text.includes('>'))

  // And it is still two blocks: the context line says where it came from either way.
  assert.equal(blocks.length, 2)
})

test('INV-core-26 a reference stays a reference, and everything else stays inert', () => {
  // In the translation a mention is the part the reader could not have guessed
  // — an id that means nothing to a person, which Slack renders as a name for
  // free. The quote above it follows the same rule (INV-core-20), so the two
  // halves of one message never disagree about who was named.
  const blocks = renderTranslation(
    { text: '<@U-ana> está de vacaciones. Usa <b> con cuidado.', foundLanguages: ['de'] },
    { authorId: 'U-jens', text: '<@U-ana> hat Urlaub. Nutze <b> vorsichtig.' },
  )
  const s = section(blocks)
  assert.ok(s?.type === 'section')
  const [quoted, translated] = s.text.text.split('\n')

  // A mention in both halves of the same message.
  assert.ok(translated?.includes('<@U-ana>'))
  assert.ok(quoted?.includes('<@U-ana>'))

  // Anything that is not one of Slack's own references is still escaped, in both.
  assert.ok(translated?.includes('&lt;b&gt;'))
  assert.ok(quoted?.includes('&lt;b&gt;'))
})

test('INV-core-28 a translation too long for one Slack block is truncated, not dropped, and says so', () => {
  // Slack rejects the whole payload for one oversized block, so `/translate 20`
  // would otherwise lose nineteen good translations to the twentieth. Cut
  // instead — and cut visibly, because a translation that just stops reads as
  // the model trailing off rather than as a limit in Slack.
  const huge = 'x'.repeat(4000)
  const blocks = renderTranslation({ text: huge, foundLanguages: ['de'] }, JENS)
  const s = section(blocks)
  assert.ok(s?.type === 'section')

  assert.ok(s.text.text.length <= 3000)
  assert.ok(s.text.text.endsWith('Cut — too long for Slack to send in one block.'))

  // The anchor is the cheap, load-bearing half — it says which message this
  // is — and the cut never touches it, no matter how long the translation runs.
  assert.ok(s.text.text.startsWith('> <@U-jens>: Passt bei mir auch!\n'))

  // And an untruncated translation is untouched: the bound only ever bites
  // once the block is actually too big to send.
  const short = renderTranslation({ text: 'Me viene bien.', foundLanguages: ['de'] }, JENS)
  const shortSection = section(short)
  assert.ok(shortSection?.type === 'section')
  assert.ok(!shortSection.text.text.includes('Cut —'))
})

test('INV-core-29 the block limit is counted after escaping, not before', () => {
  // `&` becomes `&amp;` — five characters where the original had one. A
  // translation just under the limit before escaping can still cross it after,
  // and a bound checked on the wrong side of escaping would let that through.
  const justUnderRaw = '&'.repeat(2999) // 2999 raw chars; 14995 once escaped
  const blocks = renderTranslation({ text: justUnderRaw, foundLanguages: ['de'] }, JENS)
  const s = section(blocks)
  assert.ok(s?.type === 'section')
  assert.ok(s.text.text.length <= 3000)
  assert.ok(s.text.text.endsWith('Cut — too long for Slack to send in one block.'))
})

test('INV-core-27 only Slack’s own reference syntax survives escaping', () => {
  // A loose pattern here would hand back exactly what escaping exists to
  // prevent: arbitrary text becoming markup.
  const kept = ['<@U123>', '<#C123|general>', '<!here>', '<https://example.test/x|aquí>']
  const inert = ['<b>', '<script>', '<@ U123>', '<mailto:a@b.test>', '< @U123>']

  for (const live of kept) assert.equal(escapeKeepingReferences(live), live, live)
  for (const dead of inert) assert.ok(!escapeKeepingReferences(dead).includes('<'), dead)
})

test('INV-core-30 a cut never ends inside one of Slack’s own references', () => {
  // A `<` with nothing closing it is not ordinary text to Slack's parser: an
  // unterminated reference can swallow whatever follows, including the line that
  // says the message was cut. Measured before the guard existed, twelve of these
  // ninety boundary positions left a mention open.
  for (let pad = 2900; pad < 2990; pad++) {
    const text = `${'b'.repeat(pad)} <@U0APEL2PG2C> ${'c'.repeat(200)}`
    const blocks = renderTranslation({ text, foundLanguages: ['de'] }, { authorId: 'U1', text: 'x' })
    const s = section(blocks)
    assert.ok(s?.type === 'section')
    const body = s.text.text

    assert.ok(body.length <= 3000, `over the limit at pad ${pad}`)
    const opened = body.lastIndexOf('<')
    assert.ok(opened === -1 || body.indexOf('>', opened) !== -1, `reference left open at pad ${pad}`)
  }
})

/** The one line under a rendered answer, whichever block it turned out to be. */
const contextText = (block: unknown): string =>
  (block as { elements?: readonly { text?: string }[] } | undefined)?.elements?.[0]?.text ?? ''

test('INV-core-31 outbound hands back the text itself, named by the language it is now in', async () => {
  // Everything else in this file renders somebody else's message so you can
  // read it. This renders yours so somebody else can, and what the caller
  // needs is not a report — it is the sentence, ready to copy.
  const blocks = renderOutbound('Hallo, können wir das Meeting verschieben?', 'de')
  assert.deepEqual(blocks[0], {
    type: 'section',
    text: { type: 'mrkdwn', text: 'Hallo, können wir das Meeting verschieben?' },
  })
  assert.match(contextText(blocks[1]), /^German · /)

  // Text that needed no change still comes back, and says why. The translator
  // answering "this needs nothing" is correct and useless to somebody who
  // asked for something to paste — they would be left with a line about their
  // own sentence and no sentence.
  const same = renderOutbound('Guten Morgen!', 'de', true)
  assert.deepEqual(same[0], { type: 'section', text: { type: 'mrkdwn', text: 'Guten Morgen!' } })
  assert.match(contextText(same[1]), /^Already reads as German · /)
})

test('INV-core-32 the outbound line says nothing was sent', async () => {
  // The command is called `/say`, which reads as though it will say it. It
  // will not — it hands you text to copy. A name that over-promises has to be
  // corrected somewhere, and directly under the answer is the only place the
  // correction is certain to be read.
  //
  // Pinned because the obvious "tidy-up" is to reuse the line under a
  // translation — "Translated from Spanish · only visible to you" — which is
  // true, sounds right, and drops the one fact the caller needs.
  for (const blocks of [renderOutbound('Guten Tag', 'de'), renderOutbound('Guten Tag', 'de', true)]) {
    const line = contextText(blocks[1])
    assert.ok(line.includes('nothing was sent'), line)
    assert.ok(line.includes('copy'), line)
  }
})

test('INV-core-33 the quote is never cut through the middle of a mention', () => {
  // The quote stops at a fixed length. A mention straddling that point would
  // leave half of one behind — neither a name nor readable, and a stray `<`
  // that Slack may treat as the start of markup.
  const long = `${'a'.repeat(70)} <@U0APEL2PG2C> wie sieht es bei euch aus`
  const blocks = renderTranslation({ text: 'x', foundLanguages: ['de'] }, { authorId: 'U-jens', text: long })
  const s = section(blocks)
  assert.ok(s?.type === 'section')
  const quoted = s.text.text.split('\n')[0]?.replace('> <@U-jens>: ', '') ?? ''
  assert.ok(quoted.endsWith('…'), quoted)
  assert.equal((quoted.match(/</g) ?? []).length, (quoted.match(/>/g) ?? []).length, 'every < is closed')
})

test('INV-core-34 a quote cut inside a long link keeps the start of the link, inert', () => {
  // Shared documents arrive as links longer than the quote itself. Dropping a
  // half link the way a half mention is dropped would leave the reader with an
  // ellipsis and nothing to recognise the message by.
  const link = 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit'
  const blocks = renderTranslation({ text: 'x', foundLanguages: ['de'] }, { authorId: 'U-jens', text: `<${link}> bitte prüfen` })
  const s = section(blocks)
  assert.ok(s?.type === 'section')
  const quoted = s.text.text.split('\n')[0]?.replace('> <@U-jens>: ', '') ?? ''
  assert.ok(quoted.startsWith('&lt;https://docs.google.com/spreadsheets'), quoted)
  assert.ok(quoted.endsWith('…'))
  assert.ok(!quoted.includes('<'), 'nothing in it is live markup')
})
