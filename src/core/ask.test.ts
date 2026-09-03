import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hasNothingToRead, shouldAsk } from './ask.ts'
import type { ChannelPolicy, InboundMessage, Reader } from './ports.ts'

const reader: Reader = { userId: 'U-nick', reads: ['es', 'en'] }
const enabled: ChannelPolicy = { channelId: 'C1', enabled: true }
const message = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  channelId: 'C1',
  authorId: 'U-jens',
  fromBot: false,
  text: 'Passt bei mir auch!',
  ...over,
})

test('INV-core-01 a message worth asking about is asked about', () => {
  assert.deepEqual(shouldAsk(message(), reader, enabled), { ask: true })
})

test('INV-core-02 Brissa never asks about its own output', () => {
  // Its translations are messages in the channel like any other. Without this it
  // translates itself, and then translates that.
  const d = shouldAsk(message({ fromBot: true }), reader, enabled)
  assert.deepEqual(d, { ask: false, because: 'from-a-bot' })
})

test('INV-core-03 nobody gets their own words back', () => {
  const d = shouldAsk(message({ authorId: reader.userId }), reader, enabled)
  assert.deepEqual(d, { ask: false, because: 'own-message' })
})

test('INV-core-04 a disabled channel is silent before anything else is considered', () => {
  // Checked first on purpose: a channel Brissa was switched off in must not
  // produce a decision that depended on who wrote the message.
  const d = shouldAsk(message({ fromBot: true }), reader, { channelId: 'C1', enabled: false })
  assert.deepEqual(d, { ask: false, because: 'channel-disabled' })
})

test('INV-core-05 a reader who has declared no languages is not treated as reading none', () => {
  // "Reads nothing" and "has not finished setting up" look identical in the
  // data and are opposite in what they should produce. Guessing the first makes
  // the loudest possible first impression.
  const d = shouldAsk(message(), { userId: 'U-new', reads: [] }, enabled)
  assert.deepEqual(d, { ask: false, because: 'reader-reads-nothing' })
})

test('INV-core-06 a decision to stay quiet always says why', () => {
  // An unexplained silence is indistinguishable from a bug, and silence is the
  // common case here rather than the exception.
  for (const m of [message({ fromBot: true }), message({ authorId: reader.userId }), message({ text: ':wave:' })]) {
    const d = shouldAsk(m, reader, enabled)
    assert.equal(d.ask, false)
    assert.ok(d.ask === false && d.because.length > 0)
  }
})

test('INV-core-07 a message with no readable text is not worth a model call', () => {
  // Each of these is a message shape with no sentence in it for any language to
  // be in. Asking would spend a call to be told what the shape already says.
  for (const text of [':tada:', '<@U123>', '<https://example.test/x|example>', '```const a = 1```', '👍', '   ']) {
    assert.ok(hasNothingToRead(text), `expected no readable text in ${JSON.stringify(text)}`)
  }
})

test('INV-core-08 the shortest real word is still readable text', () => {
  // `ok` is the case that makes the threshold two characters rather than one:
  // a single letter is a reaction, two is the shortest word a language has.
  for (const text of ['ok', 'ja', 'Danke!', 'a b']) {
    assert.equal(hasNothingToRead(text), false, `expected readable text in ${JSON.stringify(text)}`)
  }
})

test('INV-core-09 words survive the stripping of everything around them', () => {
  // The risk in a cleaner this aggressive is that it eats the message too. A
  // mention next to a real sentence must still count as a real sentence.
  assert.equal(hasNothingToRead('<@U123> passt bei mir :+1:'), false)
  assert.equal(hasNothingToRead('```code``` und dann?'), false)
})
