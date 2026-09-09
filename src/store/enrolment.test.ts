import assert from 'node:assert/strict'
import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { EnrolmentRecord } from '../core/enrolment.ts'
import { createFileEnrolment } from './enrolment.ts'

/** A fresh directory per test, so no test can see another's file. */
async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'brissa-enrolment-'))
}

const nick: EnrolmentRecord = { teamId: 'T1', userId: 'U-nick', reads: ['es', 'en'] }
const ana: EnrolmentRecord = { teamId: 'T1', userId: 'U-ana', reads: ['en'] }

test('INV-store-13 a person who has never enrolled reads back as undefined, not an error and not an empty record', async () => {
  const dir = await tmpDir()
  const store = createFileEnrolment(join(dir, 'enrolment.json'))
  assert.equal(await store.read('T1', 'U-stranger'), undefined)
  await rm(dir, { recursive: true, force: true })
})

test('INV-store-14 what was written is what comes back, keyed by team and user together', async () => {
  const dir = await tmpDir()
  const store = createFileEnrolment(join(dir, 'enrolment.json'))
  await store.write(nick)
  // The same userId in a different team is a different record — the whole
  // reason the key is the pair rather than userId alone.
  const sameUserOtherTeam: EnrolmentRecord = { teamId: 'T2', userId: 'U-nick', reads: ['de'] }
  await store.write(sameUserOtherTeam)

  assert.deepEqual(await store.read('T1', 'U-nick'), nick)
  assert.deepEqual(await store.read('T2', 'U-nick'), sameUserOtherTeam)
  await rm(dir, { recursive: true, force: true })
})

test('INV-store-15 off round-trips as a real record, distinguishable from never having enrolled', async () => {
  const dir = await tmpDir()
  const store = createFileEnrolment(join(dir, 'enrolment.json'))
  const off: EnrolmentRecord = { teamId: 'T1', userId: 'U-nick', reads: [] }
  await store.write(off)

  const back = await store.read('T1', 'U-nick')
  assert.notEqual(back, undefined)
  assert.deepEqual(back, off)
  // The other side of the same distinction: nobody who was never written
  // ever comes back looking like this.
  assert.notEqual(await store.read('T1', 'U-somebody-else'), off)
  await rm(dir, { recursive: true, force: true })
})

test('INV-store-16 a store nobody has ever written to answers "nobody enrolled yet", not an error', async () => {
  const dir = await tmpDir()
  // The file is never created at all — the state of every installation on
  // its first day, before anybody has run `/brissa` once.
  const store = createFileEnrolment(join(dir, 'never-written.json'))
  assert.equal(await store.read('T1', 'U-nick'), undefined)
  await rm(dir, { recursive: true, force: true })
})

test('INV-store-17 writing one person leaves another person, already on file, untouched', async () => {
  const dir = await tmpDir()
  const store = createFileEnrolment(join(dir, 'enrolment.json'))
  await store.write(nick)
  await store.write(ana)

  // A store that overwrote the whole file with one row would have lost nick
  // the moment ana was written.
  assert.deepEqual(await store.read('T1', 'U-nick'), nick)
  assert.deepEqual(await store.read('T1', 'U-ana'), ana)
  await rm(dir, { recursive: true, force: true })
})

test('INV-store-18 a write that fails before it renames leaves the previous file exactly as it was', async () => {
  const dir = await tmpDir()
  const path = join(dir, 'enrolment.json')
  const store = createFileEnrolment(path)
  await store.write(nick)

  // Writing to the temporary file is what can fail mid-way; renaming a
  // finished temporary file over the real one is the one step that cannot
  // leave a half-written result. Denying write access to the directory makes
  // the temp-file write itself fail, before any rename is attempted.
  await chmod(dir, 0o500)
  try {
    await assert.rejects(() => store.write({ teamId: 'T1', userId: 'U-nick', reads: ['de'] }))
  } finally {
    await chmod(dir, 0o700)
  }

  assert.deepEqual(await store.read('T1', 'U-nick'), nick)
  // Nothing was left behind for the next write to trip over.
  const leftover = (await readdir(dir)).filter((f) => f.endsWith('.tmp'))
  assert.deepEqual(leftover, [])
  await rm(dir, { recursive: true, force: true })
})

test('INV-store-19 two people enrolling at the same moment both stay enrolled', async () => {
  // A read-modify-write pair that overlap take the same photograph of the file,
  // each add themselves to their own copy, and the second rename wins. The
  // person who lost is told "saved" and is not — which they only discover by
  // Brissa never translating for them. Measured before the fix: two concurrent
  // writes, one record left on disk.
  const path = join(tmpdir(), `brissa-enrol-race-${process.pid}-${Math.random().toString(36).slice(2)}.json`)
  const store = createFileEnrolment(path)
  const people = ['U-nick', 'U-ana', 'U-bo', 'U-cy']

  await Promise.all(people.map((userId) => store.write({ teamId: 'T1', userId, reads: ['de'] })))

  for (const userId of people) {
    assert.ok(await store.read('T1', userId), `${userId} was lost`)
  }
  await rm(path, { force: true })
})
