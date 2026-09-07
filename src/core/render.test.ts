import assert from 'node:assert/strict'
import { test } from 'node:test'
import { escapeMrkdwn, renderTranslation } from './render.ts'
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

test('INV-core-20 the quoted original cannot mention anybody', () => {
  // The original is the one string here written by somebody else. A mention
  // inside it must arrive as evidence of what was said, never as a re-broadcast
  // — while the author's own mention, which this module builds, stays live.
  const blocks = renderTranslation(
    { text: 'Hecho.', foundLanguages: ['de'] },
    { authorId: 'U-jens', text: 'Fertig <@U-ana>, danke!' },
  )
  const s = section(blocks)
  assert.ok(s?.type === 'section')
  assert.ok(s.text.text.includes('&lt;@U-ana&gt;'))
  assert.ok(s.text.text.startsWith('> <@U-jens>: '))
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
