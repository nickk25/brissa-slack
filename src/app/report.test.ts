import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describe } from './report.ts'

test('INV-app-42 a message nobody was told about says why in one word', async () => {
  assert.equal(describe({ kind: 'nobody-to-tell' }), 'nobody-to-tell')
  assert.equal(describe({ kind: 'rejected', because: 'not-a-message' }), 'rejected')
})

test('INV-app-115 a lookup that failed says why, because now it can fail for everybody at once', async () => {
  // It used to print the bare word, and that was tolerable while `Directory`
  // was a literal built at boot: it could not really fail. It reads a file now,
  // so an unreadable or corrupt enrolment file fails *every* message rather
  // than only `/brissa` — and a hundred identical lines saying `lookup-failed`
  // are a log announcing that something is wrong while refusing to say what.
  const line = describe({ kind: 'lookup-failed', detail: 'EACCES: permission denied, open /data/enrolment.json' })
  assert.ok(line.startsWith('lookup-failed'), line)
  assert.ok(line.includes('EACCES'), 'the reason is the only part worth reading')
})

test('INV-app-43 readers are counted by what happened to them, skips by their reason', async () => {
  // A run of thirty `skipped:channel-disabled` and one `delivered` should read as
  // two numbers, not thirty-one lines.
  const line = describe({
    kind: 'considered',
    readers: [
      { userId: 'U1', kind: 'sent' },
      { userId: 'U2', kind: 'sent' },
      { userId: 'U3', kind: 'skipped', because: 'channel-disabled' },
      { userId: 'U4', kind: 'silent' },
    ],
  })
  assert.equal(line, 'sent×2 skipped:channel-disabled×1 silent×1')
})

test('INV-app-44 a failure is spelled out rather than counted away', async () => {
  // Everything else here is a tally. A failure is the one outcome where the
  // number tells you nothing and the reason is the whole message — and the rule
  // at the root of this repository is that an error is never swallowed.
  const line = describe({
    kind: 'considered',
    readers: [
      { userId: 'U1', kind: 'sent' },
      { userId: 'U2', kind: 'failed', stage: 'translate', detail: 'overloaded' },
    ],
  })
  assert.ok(line.includes('translate: overloaded'))
  assert.ok(line.includes('sent×1'))
})
