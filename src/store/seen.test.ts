import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMemorySeen } from './seen.ts'

test('INV-store-09 a delivery is new exactly once', async () => {
  const seen = createMemorySeen()
  assert.equal(await seen.firstTime('Ev1'), true)
  assert.equal(await seen.firstTime('Ev1'), false)
  assert.equal(await seen.firstTime('Ev1'), false)
})

test('INV-store-10 recording is part of asking', async () => {
  // A check the caller has to follow with a separate record is a check that says
  // yes twice whenever anyone forgets — and the place it would be forgotten is
  // the error path, which is exactly where retries come from.
  const seen = createMemorySeen()
  await seen.firstTime('Ev1')
  await seen.firstTime('Ev2')
  assert.equal(await seen.firstTime('Ev1'), false)
  assert.equal(await seen.firstTime('Ev3'), true)
})

test('INV-store-11 it forgets the oldest, and only the oldest', async () => {
  // The alternative is a process whose memory grows with every message the
  // workspace has ever sent, which is fine right up until it is not.
  const seen = createMemorySeen(3)
  for (const id of ['a', 'b', 'c']) await seen.firstTime(id)

  // Still all remembered at capacity.
  assert.equal(await seen.firstTime('c'), false)
  assert.equal(await seen.firstTime('a'), false)

  assert.equal(await seen.firstTime('d'), true)

  // The survivors are checked before the evicted one, and the order is the whole
  // point: asking about 'a' re-inserts it and evicts 'b' in passing, so a store
  // that dropped two ids per overflow would be indistinguishable from this one
  // if 'a' were asked first.
  assert.equal(await seen.firstTime('b'), false)
  assert.equal(await seen.firstTime('c'), false)
  assert.equal(await seen.firstTime('d'), false)

  // And only now the one that was actually dropped.
  assert.equal(await seen.firstTime('a'), true)
})

test('INV-store-12 asking again does not keep an id alive longer', async () => {
  // Insertion order is the eviction order, and this is not an LRU pretending to
  // be one: an id offered twice is a duplicate, not a use.
  const seen = createMemorySeen(2)
  await seen.firstTime('a')
  await seen.firstTime('b')
  await seen.firstTime('a') // a duplicate, not a refresh
  await seen.firstTime('c') // evicts 'a', the oldest, despite it being asked last

  assert.equal(await seen.firstTime('a'), true)
})
