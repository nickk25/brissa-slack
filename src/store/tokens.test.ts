import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createFileTokens, type UserTokenRecord } from './tokens.ts'

/** A fresh directory per test, so no test can see another's file. */
async function tmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'brissa-tokens-'))
}

const nick: UserTokenRecord = { teamId: 'T1', userId: 'U-nick', token: 'xoxp-nick-secret' }
const ana: UserTokenRecord = { teamId: 'T1', userId: 'U-ana', token: 'xoxp-ana-secret' }

const KEY = randomBytes(32).toString('base64')

test('INV-store-20 a person who has never connected reads back as undefined, not an error', async () => {
  const dir = await tmpDir()
  const store = createFileTokens(join(dir, 'tokens.json'), KEY)
  assert.equal(await store.read('T1', 'U-stranger'), undefined)
  await rm(dir, { recursive: true, force: true })
})

test('INV-store-21 what was written is what comes back, keyed by team and user together', async () => {
  const dir = await tmpDir()
  const store = createFileTokens(join(dir, 'tokens.json'), KEY)
  await store.write(nick)
  // The same userId in a different team is a different record — the whole
  // reason the key is the pair rather than userId alone.
  const sameUserOtherTeam: UserTokenRecord = { teamId: 'T2', userId: 'U-nick', token: 'xoxp-other-team' }
  await store.write(sameUserOtherTeam)

  assert.deepEqual(await store.read('T1', 'U-nick'), nick)
  assert.deepEqual(await store.read('T2', 'U-nick'), sameUserOtherTeam)
  await rm(dir, { recursive: true, force: true })
})

test('INV-store-22 a store nobody has ever written to answers "nobody connected yet", not an error', async () => {
  const dir = await tmpDir()
  // The file is never created at all — the state of every installation on
  // its first day, before anybody has connected a Slack account.
  const store = createFileTokens(join(dir, 'never-written.json'), KEY)
  assert.equal(await store.read('T1', 'U-nick'), undefined)
  await rm(dir, { recursive: true, force: true })
})

test('INV-store-23 writing one person leaves another person, already on file, untouched', async () => {
  const dir = await tmpDir()
  const store = createFileTokens(join(dir, 'tokens.json'), KEY)
  await store.write(nick)
  await store.write(ana)

  // A store that overwrote the whole file with one row would have lost
  // nick's token the moment ana's was written.
  assert.deepEqual(await store.read('T1', 'U-nick'), nick)
  assert.deepEqual(await store.read('T1', 'U-ana'), ana)
  await rm(dir, { recursive: true, force: true })
})

test('INV-store-24 a write that fails before it renames leaves the previous file exactly as it was', async () => {
  const dir = await tmpDir()
  const path = join(dir, 'tokens.json')
  const store = createFileTokens(path, KEY)
  await store.write(nick)

  // Writing to the temporary file is what can fail mid-way; renaming a
  // finished temporary file over the real one is the one step that cannot
  // leave a half-written result. Denying write access to the directory makes
  // the temp-file write itself fail, before any rename is attempted.
  await chmod(dir, 0o500)
  try {
    await assert.rejects(() => store.write({ teamId: 'T1', userId: 'U-nick', token: 'xoxp-new' }))
  } finally {
    await chmod(dir, 0o700)
  }

  assert.deepEqual(await store.read('T1', 'U-nick'), nick)
  // Nothing was left behind for the next write to trip over.
  const leftover = (await readdir(dir)).filter((f) => f.endsWith('.tmp'))
  assert.deepEqual(leftover, [])
  await rm(dir, { recursive: true, force: true })
})

test('INV-store-25 two people connecting at the same moment both keep their tokens', async () => {
  // A read-modify-write pair that overlap take the same photograph of the
  // file, each add themselves to their own copy, and the second rename wins.
  // The person who lost is told "connected" and is not — discovering it only
  // when Brissa can no longer act for them. Measured before the fix: two
  // concurrent writes, one record left on disk.
  const path = join(tmpdir(), `brissa-tokens-race-${process.pid}-${Math.random().toString(36).slice(2)}.json`)
  const store = createFileTokens(path, KEY)
  const people = ['U-nick', 'U-ana', 'U-bo', 'U-cy']

  await Promise.all(people.map((userId) => store.write({ teamId: 'T1', userId, token: `xoxp-${userId}` })))

  for (const userId of people) {
    assert.ok(await store.read('T1', userId), `${userId} was lost`)
  }
  await rm(path, { force: true })
})

test('INV-store-26 the file on disk is created readable only by the owning process', async () => {
  const dir = await tmpDir()
  const path = join(dir, 'tokens.json')
  const store = createFileTokens(path, KEY)
  await store.write(nick)

  const { mode } = await stat(path)
  assert.equal(mode & 0o777, 0o600)
  await rm(dir, { recursive: true, force: true })
})

test('INV-store-27 the file stays readable only by the owning process across a second write', async () => {
  // The mode is asserted on every write, not just the first — a `writeFile`
  // whose `mode` option only takes effect on creation would silently pass
  // the first test above and still leak on every write after the first.
  const dir = await tmpDir()
  const path = join(dir, 'tokens.json')
  const store = createFileTokens(path, KEY)
  await store.write(nick)
  await store.write(ana)

  const { mode } = await stat(path)
  assert.equal(mode & 0o777, 0o600)
  await rm(dir, { recursive: true, force: true })
})

test('INV-store-28 deleting a person removes them; a later read reports undefined', async () => {
  const dir = await tmpDir()
  const store = createFileTokens(join(dir, 'tokens.json'), KEY)
  await store.write(nick)
  assert.notEqual(await store.read('T1', 'U-nick'), undefined)

  await store.forget('T1', 'U-nick')
  assert.equal(await store.read('T1', 'U-nick'), undefined)
  await rm(dir, { recursive: true, force: true })
})

test('INV-store-29 deleting a person who was never connected is not an error', async () => {
  const dir = await tmpDir()
  const store = createFileTokens(join(dir, 'tokens.json'), KEY)
  await assert.doesNotReject(() => store.forget('T1', 'U-stranger'))
  await rm(dir, { recursive: true, force: true })
})

test('INV-store-30 deleting one person leaves another person, already on file, untouched', async () => {
  const dir = await tmpDir()
  const store = createFileTokens(join(dir, 'tokens.json'), KEY)
  await store.write(nick)
  await store.write(ana)

  await store.forget('T1', 'U-nick')
  assert.equal(await store.read('T1', 'U-nick'), undefined)
  assert.deepEqual(await store.read('T1', 'U-ana'), ana)
  await rm(dir, { recursive: true, force: true })
})

test('INV-store-31 a failure to read a corrupt file reports the path, never the contents', async () => {
  const dir = await tmpDir()
  const path = join(dir, 'tokens.json')
  const secretMarker = 'xoxp-do-not-leak-this-into-an-error-message'
  await writeFile(path, `{ not json, but it does contain ${secretMarker}`, 'utf8')

  const store = createFileTokens(path, KEY)
  await assert.rejects(
    () => store.read('T1', 'U-nick'),
    (err: Error) => {
      assert.ok(err.message.includes(path), 'error should name the path')
      assert.ok(!err.message.includes(secretMarker), 'error must not echo the file contents')
      return true
    },
  )
  await rm(dir, { recursive: true, force: true })
})

test('INV-store-32 nothing here writes to console.log, console.warn or console.error', async () => {
  // The whole reason this file gets its own module, its own permissions and
  // its own contract is that a token must never leak — and the cheapest
  // place a leak happens first is a stray console call. A full run — write,
  // read, a corrupt read, and delete — is spied on end to end and must make
  // none.
  const dir = await tmpDir()
  const path = join(dir, 'tokens.json')
  const corruptPath = join(dir, 'corrupt.json')
  await writeFile(corruptPath, '{ not json', 'utf8')

  const calls: unknown[][] = []
  const original = { log: console.log, warn: console.warn, error: console.error }
  console.log = (...args: unknown[]) => calls.push(args)
  console.warn = (...args: unknown[]) => calls.push(args)
  console.error = (...args: unknown[]) => calls.push(args)
  try {
    const store = createFileTokens(path, KEY)
    await store.write(nick)
    await store.read('T1', 'U-nick')
    await store.forget('T1', 'U-nick')

    const corrupt = createFileTokens(corruptPath, KEY)
    await assert.rejects(() => corrupt.read('T1', 'U-nick'))
  } finally {
    console.log = original.log
    console.warn = original.warn
    console.error = original.error
  }
  assert.deepEqual(calls, [])
  await rm(dir, { recursive: true, force: true })
})

test('INV-store-33 a token taken off the disk without the key is noise', async () => {
  // `0600` on an encrypted volume already stops another process on the box. It
  // does not stop a volume snapshot, a backup, or a copy taken by anything that
  // could read the file — and those travel. The key lives in the environment
  // and never on the volume, so a file without it is nothing.
  //
  // This buys nothing against something that compromises the running process:
  // that has the key by definition.
  const dir = await tmpDir()
  const path = join(dir, 'tokens.json')
  await createFileTokens(path, KEY).write({ teamId: 'T1', userId: 'U-nick', token: 'xoxp-the-real-thing' })

  const onDisk = await readFile(path, 'utf8')
  assert.ok(!onDisk.includes('xoxp-the-real-thing'), 'the token must not be on disk in the clear')
  assert.ok(!onDisk.includes('U-nick'), 'nor should who it belongs to be')

  await rm(dir, { recursive: true, force: true })
})

test('INV-store-34 a file edited by hand fails to open rather than opening wrong', async () => {
  // The authentication tag, doing the job it is there for. Without it a flipped
  // byte decrypts to something else, and a store that silently returns a
  // mangled token is worse than one that refuses.
  const dir = await tmpDir()
  const path = join(dir, 'tokens.json')
  await createFileTokens(path, KEY).write({ teamId: 'T1', userId: 'U-nick', token: 'xoxp-x' })

  const sealed = JSON.parse(await readFile(path, 'utf8')) as { body: string }
  const flipped = Buffer.from(sealed.body, 'base64')
  flipped[0] = (flipped[0] ?? 0) ^ 0xff
  await writeFile(path, JSON.stringify({ ...sealed, body: flipped.toString('base64') }))

  await assert.rejects(() => createFileTokens(path, KEY).read('T1', 'U-nick'), /could not be decrypted/)

  // And the wrong key is refused the same way, because from here the two are
  // indistinguishable — which is the point. A fresh file, because writing to
  // the tampered one would have to read it first.
  const second = join(dir, 'other.json')
  await createFileTokens(second, KEY).write({ teamId: 'T1', userId: 'U-nick', token: 'xoxp-x' })
  const other = randomBytes(32).toString('base64')
  await assert.rejects(() => createFileTokens(second, other).read('T1', 'U-nick'), /could not be decrypted/)

  await rm(dir, { recursive: true, force: true })
})

test('INV-store-35 a key that is not a key is refused rather than stretched', async () => {
  // A short key quietly padded produces a file that looks encrypted and is not,
  // and nothing afterwards would ever say so.
  for (const bad of ['', 'short', Buffer.alloc(16).toString('base64')]) {
    assert.throws(() => createFileTokens('/tmp/never-written.json', bad), /32 bytes/)
  }
})
