import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChannelPolicy, Reader } from '../core/ports.ts'
import { createMemoryDirectory } from './memory.ts'

const nick: Reader = { userId: 'U-nick', reads: ['es', 'en'] }
const ana: Reader = { userId: 'U-ana', reads: ['es', 'en'] }
const on: ChannelPolicy = { channelId: 'C1', enabled: true }
const off: ChannelPolicy = { channelId: 'C2', enabled: false }

test('INV-store-01 a channel somebody decided about comes back as they decided', async () => {
  const d = createMemoryDirectory({ readers: [nick], channels: [on, off] })
  assert.deepEqual((await d.lookup('C1')).policy, on)
  assert.deepEqual((await d.lookup('C2')).policy, off)
})

test('INV-store-02 a channel nobody decided about is disabled, not absent', async () => {
  // The caller must never have to check for undefined to find out whether to
  // stay quiet. "Never heard of it" and "switched off here" produce the same
  // thing, and only one of them needs remembering.
  const d = createMemoryDirectory({ readers: [nick] })
  assert.deepEqual((await d.lookup('C-unknown')).policy, { channelId: 'C-unknown', enabled: false })
})

test('INV-store-03 what an undecided channel defaults to is the caller’s choice, not this module’s', async () => {
  // Brissa is sold as working everywhere at once; the rest of this codebase says
  // silence is the default. Both are defensible, so the code does not get to
  // pick one quietly.
  const d = createMemoryDirectory({ readers: [nick], unknownChannels: 'enabled' })
  assert.deepEqual((await d.lookup('C-unknown')).policy, { channelId: 'C-unknown', enabled: true })
})

test('INV-store-04 a disabled channel still reports its readers', async () => {
  // The store answers what is; deciding what that means is `shouldAsk`. Hiding
  // the readers here would move a product rule into a lookup, where no corpus
  // and no eval can ever reach it.
  const view = await createMemoryDirectory({ readers: [nick, ana], channels: [off] }).lookup('C2')
  assert.equal(view.policy.enabled, false)
  assert.deepEqual(view.readers, [nick, ana])
})

test('INV-store-05 a directory that knows nobody answers rather than fails', async () => {
  // The state on the first day of any workspace. An empty answer is a real
  // answer; a throw here would make "not set up yet" arrive as an incident.
  const view = await createMemoryDirectory().lookup('C1')
  assert.deepEqual(view, { policy: { channelId: 'C1', enabled: false }, readers: [] })
})

test('INV-store-06 a reader listed twice is one reader', async () => {
  // Two entries would send the same person the same translation twice, and the
  // duplicate would look like a bug in the translator rather than in a list.
  const twice: Reader = { userId: 'U-nick', reads: ['de'] }
  const view = await createMemoryDirectory({ readers: [nick, twice] }).lookup('C1')
  assert.deepEqual(view.readers, [twice])
})

test('INV-store-07 every enrolled reader comes back for every channel', async () => {
  // Channel membership is Slack's fact and only `src/slack` may ask for it, so
  // this module does not pretend to know it. Slack's own `user_not_in_channel`
  // removes whoever was not there.
  const d = createMemoryDirectory({ readers: [nick, ana], channels: [on] })
  assert.deepEqual((await d.lookup('C1')).readers, [nick, ana])
  assert.deepEqual((await d.lookup('C-elsewhere')).readers, [nick, ana])
})

test('INV-store-08 the same question asked twice gets the same answer', async () => {
  // No hidden state, no cache that can go stale between two reads of one
  // message. Every later implementation has to keep this within one lookup.
  const d = createMemoryDirectory({ readers: [nick], channels: [on] })
  assert.deepEqual(await d.lookup('C1'), await d.lookup('C1'))
})
