import assert from 'node:assert/strict'
import { test } from 'node:test'
import { escapeMrkdwn, renderTranslation } from './render.ts'

const section = (blocks: readonly ReturnType<typeof renderTranslation>[number][]) =>
  blocks.find((b) => b.type === 'section')
const context = (blocks: readonly ReturnType<typeof renderTranslation>[number][]) =>
  blocks.find((b) => b.type === 'context')

test('INV-core-10 a translation renders as the message and one line of context', () => {
  // It sits underneath a message the reader is already looking at. A header or a
  // divider would make it read as a separate announcement.
  const blocks = renderTranslation({ text: 'Me viene bien.', foundLanguages: ['de'] })
  assert.equal(blocks.length, 2)
  assert.equal(section(blocks)?.type, 'section')
  assert.equal(context(blocks)?.type, 'context')
})

test('INV-core-11 the context says the message is visible to nobody else', () => {
  // Without it, a first-time reader's reasonable assumption is that the whole
  // channel just watched a bot translate a colleague for them.
  const blocks = renderTranslation({ text: 'x', foundLanguages: ['de'] })
  const c = context(blocks)
  assert.ok(c?.type === 'context' && /only visible to you/i.test(c.elements[0]?.text ?? ''))
})

test('INV-core-12 languages are named, not printed as codes', () => {
  const blocks = renderTranslation({ text: 'x', foundLanguages: ['de'] })
  const c = context(blocks)
  assert.ok(c?.type === 'context' && c.elements[0]?.text.includes('German'))
})

test('INV-core-13 several languages read as a list rather than a join', () => {
  const blocks = renderTranslation({ text: 'x', foundLanguages: ['de', 'fr', 'nl'] })
  const c = context(blocks)
  assert.ok(c?.type === 'context' && /German, French and Dutch/.test(c.elements[0]?.text ?? ''))
})

test('INV-core-14 an unknown language code is shown rather than dropped', () => {
  // Losing it would leave "Translated" with no source at all, which reads as a
  // bug rather than as a language nobody named yet.
  const blocks = renderTranslation({ text: 'x', foundLanguages: ['zz'] })
  const c = context(blocks)
  assert.ok(c?.type === 'context' && c.elements[0]?.text.includes('zz'))
})

test('INV-core-15 the translated text is escaped so Slack cannot re-format it', () => {
  // A stray angle bracket in the original would otherwise become markup in the
  // translation — the message changing shape on its way to the reader.
  const blocks = renderTranslation({ text: 'a < b & c > d', foundLanguages: ['de'] })
  const s = section(blocks)
  assert.ok(s?.type === 'section' && s.text.text === 'a &lt; b &amp; c &gt; d')
})

test('INV-core-16 escaping leaves ordinary text untouched', () => {
  assert.equal(escapeMrkdwn('Passt bei mir auch! 👍 https://example.test/x'), 'Passt bei mir auch! 👍 https://example.test/x')
})
