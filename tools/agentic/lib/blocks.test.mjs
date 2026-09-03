import assert from 'node:assert/strict'
import { test } from 'node:test'
import { danglingBlocks, duplicateBlocks, findBlocks, render, replaceBlock, unterminatedFence } from './blocks.mjs'

const doc = (body) => `# Title\n\n<!-- gen:demo -->\n${body}\n<!-- /gen:demo -->\n\ntail\n`

test('a block is found and its body replaced, markers untouched', () => {
  const out = replaceBlock(doc('old'), 'demo', 'new')
  assert.match(out, /<!-- gen:demo -->\nnew\n<!-- \/gen:demo -->/)
  assert.match(out, /tail/)
})

test('INV-blocks-01 markers inside a code fence are examples, not regions', () => {
  // Documenting this syntax means showing it. Without fence awareness, writing
  // the docs for the feature silently corrupts them the next time it runs.
  const text = [
    'Explaining the syntax:',
    '',
    '```',
    '<!-- gen:demo -->',
    'illustrative only',
    '<!-- /gen:demo -->',
    '```',
    '',
    '<!-- gen:demo -->',
    'the real one',
    '<!-- /gen:demo -->',
  ].join('\n')

  const blocks = findBlocks(text)
  assert.equal(blocks.length, 1, 'the fenced example must not count as a block')
  assert.equal(blocks[0].body.trim(), 'the real one')

  const out = replaceBlock(text, 'demo', 'generated')
  assert.match(out, /illustrative only/, 'the example must survive untouched')
  assert.doesNotMatch(out, /illustrative only[\s\S]*generated[\s\S]*illustrative/)
  assert.match(out, /<!-- gen:demo -->\ngenerated\n<!-- \/gen:demo -->/)
})

test('a tilde fence masks just like a backtick fence', () => {
  const text = '~~~\n<!-- gen:demo -->\nx\n<!-- /gen:demo -->\n~~~\n'
  assert.equal(findBlocks(text).length, 0)
})

test('INV-blocks-02 an unclosed marker is reported rather than ignored', () => {
  // The region stops being checked with no other signal, which is the failure
  // that matters: the contract looks maintained and is not.
  assert.deepEqual(danglingBlocks('<!-- gen:orphan -->\nbody\n'), ['orphan'])
  assert.deepEqual(danglingBlocks(doc('x')), [])
})

test('INV-blocks-03 a block with no generator is left alone, never emptied', async () => {
  // Emptying it because a generator was renamed would delete the only part of a
  // contract that was actually true.
  const before = doc('precious')
  const { text, unknown, rendered } = await render(before, {}, {})
  assert.equal(text, before)
  assert.deepEqual(unknown, ['demo'])
  assert.deepEqual(rendered, [])
})

test('INV-blocks-04 an empty block body round-trips without corrupting the markers', async () => {
  // indexOf('') returns its search start, so an empty body used to land the
  // replacement inside the opening marker line, producing "<!-- gen:x -->new"
  // and permanently mangling the marker on the very first render.
  const empty = '<!-- gen:demo -->\n<!-- /gen:demo -->\n'
  const out = replaceBlock(empty, 'demo', 'filled in')
  assert.equal(out, '<!-- gen:demo -->\nfilled in\n<!-- /gen:demo -->\n')
})

test('INV-blocks-05 rendering an already-rendered document is a no-op', async () => {
  // `contracts` writing a file that `contracts --check` then flags as stale is
  // the tool contradicting itself on the very next run.
  const generators = { demo: () => 'stable output' }
  const first = await render(doc(''), generators, {})
  const second = await render(first.text, generators, {})
  assert.equal(second.text, first.text)
  assert.deepEqual(second.rendered, ['demo'])
})

test('INV-blocks-06 an unterminated code fence is reported by line, not silently ignored', () => {
  // Leaving inFence true to end of file makes every later block invisible to
  // findBlocks and danglingBlocks alike — a check could pass green having
  // examined nothing after the break.
  const text = ['prose', '', '```js', "const x = 1", '', '<!-- gen:demo -->', 'body', '<!-- /gen:demo -->'].join('\n')
  assert.equal(unterminatedFence(text), 3)
  assert.equal(findBlocks(text).length, 0, 'the block after the broken fence must not be seen')
})

test('INV-blocks-07 a closed fence reports no unterminated fence', () => {
  assert.equal(unterminatedFence(doc('x')), null)
})

test('INV-blocks-08 two blocks sharing a name are reported as a duplicate, not partially rendered', async () => {
  // render() and replaceBlock() both resolve a block by name, so the second
  // declaration is never reachable — it would look maintained while actually
  // going unchecked. That has to fail loudly instead of picking a winner.
  const text = ['<!-- gen:demo -->', 'first', '<!-- /gen:demo -->', '', '<!-- gen:demo -->', 'second', '<!-- /gen:demo -->'].join('\n')
  const dupes = duplicateBlocks(text)
  assert.equal(dupes.length, 1)
  assert.equal(dupes[0].name, 'demo')
  assert.deepEqual(dupes[0].lines, [1, 5])

  await assert.rejects(
    () => render(text, { demo: () => 'x' }, {}),
    (err) => {
      // What an agent needs to fix this: the name that collided, and both
      // lines it collided on.
      assert.match(err.message, /"demo"/)
      assert.match(err.message, /1, 5/, 'both colliding lines must be listed together, comma-separated, not run together or dropped')
      return true
    },
  )
})

test('INV-blocks-09 a document with no duplicate names reports none', () => {
  assert.deepEqual(duplicateBlocks(doc('x')), [])
})

test('INV-blocks-10 unterminatedFence recognises a real closing fence, not just the absence of one', () => {
  // Neither existing unterminated-fence test above ever reaches a genuine
  // closing marker: INV-blocks-06's fence never closes at all, and
  // INV-blocks-07 has no fence in the first place. Nothing proves the
  // closing branch actually closes anything.
  const text = ['```js', 'const x = 1', '```', 'prose after'].join('\n')
  assert.equal(unterminatedFence(text), null, 'a fence that actually closes must not be reported as unterminated')
})

test('INV-blocks-11 a fence closed with the wrong fence character stays open', () => {
  const text = ['```js', 'const x = 1', '~~~', 'more code, still fenced'].join('\n')
  assert.equal(unterminatedFence(text), 1, 'a ~~~ line must not close a ``` fence, or vice versa')
})

test('INV-blocks-12 a mismatched fence character does not end masking early either', () => {
  // Same fact as INV-blocks-11, checked through maskFences (via findBlocks)
  // rather than unterminatedFence: a `~~~` line inside a ``` block must not
  // stop the mask, or a marker meant only as an example inside it would
  // start counting as a real block.
  const text = [
    '```',
    '<!-- gen:demo -->',
    'x',
    '<!-- /gen:demo -->',
    '~~~',
    '<!-- gen:demo -->',
    'still fenced',
    '<!-- /gen:demo -->',
    '```',
  ].join('\n')
  assert.equal(findBlocks(text).length, 0, 'everything here sits inside one ``` fence; a ~~~ line must not end it early')
})

test('INV-blocks-13 findBlocks reports start/end offsets that bound the whole marker-to-marker text', () => {
  const text = doc('body text')
  const [block] = findBlocks(text)
  assert.equal(text.slice(block.start, block.end), '<!-- gen:demo -->\nbody text\n<!-- /gen:demo -->')
})

test('INV-blocks-14 danglingBlocks pairs a repeated name one-to-one, not by mere presence', () => {
  // Two opens, one close: exactly one of the two must be reported dangling.
  // A pairing that does not consume a matched close as it goes would find
  // the same leftover close for both opens and wrongly call neither dangling.
  const text = ['<!-- gen:demo -->', 'a', '<!-- gen:demo -->', 'b', '<!-- /gen:demo -->'].join('\n')
  assert.deepEqual(danglingBlocks(text), ['demo'])
})

test('INV-blocks-15 replaceBlock finds the block by name, not merely the first one in the document', () => {
  const text = ['<!-- gen:first -->', 'A', '<!-- /gen:first -->', '', '<!-- gen:second -->', 'B', '<!-- /gen:second -->'].join('\n')
  const out = replaceBlock(text, 'second', 'B2')
  assert.match(out, /<!-- gen:first -->\nA\n<!-- \/gen:first -->/, 'the first block must be left untouched')
  assert.match(out, /<!-- gen:second -->\nB2\n<!-- \/gen:second -->/, 'the named block must be the one replaced')
})

test('INV-blocks-16 replaceBlock leaves the text untouched when no block with that name exists', () => {
  const text = doc('body')
  assert.equal(replaceBlock(text, 'missing', 'X'), text)
})

test('INV-blocks-17 replaceBlock does not double a body that already ends with a newline', () => {
  const out = replaceBlock(doc(''), 'demo', 'already terminated\n')
  assert.match(out, /already terminated\n<!-- \/gen:demo -->/, 'a body that already ends in \\n must not gain a second one')
  assert.doesNotMatch(out, /already terminated\n\n<!-- \/gen:demo -->/)
})
