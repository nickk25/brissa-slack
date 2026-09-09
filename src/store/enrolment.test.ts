import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { EnrolmentRecord } from '../core/enrolment.ts'
import { createFileDirectory, createFileEnrolment } from './enrolment.ts'

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

// ---------------------------------------------------------------------------
// The directory over that same file.
//
// These exist because the two halves used to be strangers: `/brissa` wrote a
// record here and the `Directory` every message consults was built once at boot
// from an environment variable. Enrolling saved something nothing read, and the
// command could report languages that were not the ones deciding anything.
// ---------------------------------------------------------------------------

const on = { channels: [{ channelId: 'C1', enabled: true }] }

test('INV-store-38 somebody who enrols is a reader on the very next lookup, with no restart', async () => {
  // The bug this file exists to prevent, written as the shortest sentence that
  // would have caught it: one file, written through `Enrolment`, read through
  // `Directory`.
  const dir = await tmpDir()
  const path = join(dir, 'enrolment.json')
  const store = createFileEnrolment(path)
  const directory = createFileDirectory(path, on)

  assert.deepEqual((await directory.lookup('C1')).readers, [], 'nobody has said anything yet')

  await store.write({ teamId: 'T1', userId: 'U-nick', reads: ['es'] })

  assert.deepEqual((await directory.lookup('C1')).readers, [{ userId: 'U-nick', reads: ['es'] }])
  await rm(dir, { recursive: true, force: true })
})

test('INV-store-39 somebody who turned translation off is a reader who reads nothing, not an absent one', async () => {
  // `/brissa off` writes an empty `reads`, and `shouldAsk` turns that into
  // `reader-reads-nothing` — a different answer from never having met them.
  // Filtering them out here would erase the distinction the record was written
  // to hold, and `/brissa` would go back to reporting "never enrolled" to
  // somebody who had enrolled and stopped.
  const dir = await tmpDir()
  const path = join(dir, 'enrolment.json')
  const store = createFileEnrolment(path)
  const directory = createFileDirectory(path, on)

  await store.write({ teamId: 'T1', userId: 'U-nick', reads: [] })

  assert.deepEqual((await directory.lookup('C1')).readers, [{ userId: 'U-nick', reads: [] }])
  await rm(dir, { recursive: true, force: true })
})

test('INV-store-40 a missing file is a directory that knows nobody, not a broken one', async () => {
  // The state of every installation before the first `/brissa`, and it must
  // read as silence rather than as a fault.
  const dir = await tmpDir()
  const view = await createFileDirectory(join(dir, 'nothing-here.json'), on).lookup('C1')
  assert.deepEqual(view.readers, [])
  assert.deepEqual(view.policy, { channelId: 'C1', enabled: true })
  await rm(dir, { recursive: true, force: true })
})

test('INV-store-41 a file that cannot be read is a broken directory, never an empty workspace', async () => {
  // The failure that must never be quiet. Returning "nobody reads anything"
  // for an unreadable file would make a corrupt volume indistinguishable from
  // a workspace where nobody has enrolled — Brissa would go silent everywhere
  // and every log line would say it was working as intended.
  const dir = await tmpDir()
  const path = join(dir, 'enrolment.json')
  await writeFile(path, '{ this is not json', 'utf8')

  await assert.rejects(() => createFileDirectory(path, on).lookup('C1'))

  // And the same for a shape that opens but is not a file.
  const asDir = join(dir, 'a-directory.json')
  await mkdir(asDir)
  await assert.rejects(() => createFileDirectory(asDir, on).lookup('C1'))
  await rm(dir, { recursive: true, force: true })
})

test('INV-store-42 two lookups with no write between agree, and a lookup after a write sees it', async () => {
  // The reason there is no cache. `createFileEnrolment` states the rule for its
  // own reads; it matters more here, because this is the hot path and a cache
  // is the tempting thing to add — and a cached directory would serve somebody
  // their old languages until the next restart, which is the bug this whole
  // change exists to remove, rebuilt in memory.
  const dir = await tmpDir()
  const path = join(dir, 'enrolment.json')
  const store = createFileEnrolment(path)
  const directory = createFileDirectory(path, on)

  await store.write({ teamId: 'T1', userId: 'U-nick', reads: ['es', 'en'] })
  assert.deepEqual(await directory.lookup('C1'), await directory.lookup('C1'))

  await store.write({ teamId: 'T1', userId: 'U-nick', reads: ['es'] })
  assert.deepEqual((await directory.lookup('C1')).readers, [{ userId: 'U-nick', reads: ['es'] }])
  await rm(dir, { recursive: true, force: true })
})

test('INV-store-43 readers come back whatever team they are filed under, and one person is one reader', async () => {
  // Stated out loud rather than left implicit. Records are keyed by
  // `(teamId, userId)` and `Directory.lookup` is given a channel and nothing
  // else, so this ignores the team — which is correct while one bot token
  // serves one workspace, and is the assumption that has to be revisited the
  // day Brissa is installed twice. This test is what fails on that day, rather
  // than somebody in one workspace being served for a channel in another.
  const dir = await tmpDir()
  const path = join(dir, 'enrolment.json')
  const store = createFileEnrolment(path)
  const directory = createFileDirectory(path, on)

  await store.write({ teamId: 'T1', userId: 'U-nick', reads: ['es'] })
  await store.write({ teamId: 'T2', userId: 'U-nick', reads: ['de'] })
  await store.write({ teamId: 'T1', userId: 'U-ana', reads: ['en'] })

  const { readers } = await directory.lookup('C1')
  // One row per person, never two — two would send the same person the same
  // translation twice, which reads as a bug in the translator rather than here.
  assert.equal(readers.filter((r) => r.userId === 'U-nick').length, 1)
  assert.equal(readers.length, 2)
  await rm(dir, { recursive: true, force: true })
})
