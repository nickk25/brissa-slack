/**
 * Who Brissa can act as, one Slack token per `(teamId, userId)`, kept on disk.
 *
 * This answers the same shape of question `enrolment.ts` does — read one
 * person, write one person, keyed by the pair — and for that reason it is
 * tempting to fold the two together. Resist it: `enrolment.ts` holds a
 * preference somebody is happy to have printed in a support channel; this
 * file holds a credential that lets Brissa act as that person on Slack.
 * Merging them means every future reader of "who reads what" also reads a
 * token, and every backup, log scrape or debug dump of one becomes a leak of
 * the other. One file, one blast radius — keep this one smaller.
 *
 * `src/core/tokens.ts` is being written alongside this file by another agent
 * against a port that might still be in motion. `Tokens` and `UserTokenRecord`
 * below are this module's own account of the shape it needs; the report for
 * this change says so explicitly, so the two can be reconciled by hand
 * rather than by one silently overwriting the other.
 *
 * The path is a constructor parameter, never `process.env` read from inside
 * this module — the same rule `enrolment.ts` and `memory.ts` state: only
 * `src/app/main.ts` reads the environment.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * The port this module answers, declared locally rather than imported from
 * `src/core/tokens.ts` — see the module comment for why. Shaped after
 * `Enrolment` in `src/core/enrolment.ts`, with the one addition a credential
 * needs that a preference does not: a way to remove it.
 */
/**
 * The record is the port's, not this file's.
 *
 * It was declared here once, independently, while `src/core/tokens.ts` was
 * being written in parallel — and the two disagreed about what the field
 * holding the credential was called. Importing it means the next disagreement
 * is a compile error rather than something discovered by whoever wires them
 * together.
 */
import type { Tokens, UserTokenRecord } from '../core/tokens.ts'
export type { UserTokenRecord }


/** One row per `(teamId, userId)`, the same key `UserTokenRecord` is declared by. */
type OnDisk = Record<string, UserTokenRecord>

const key = (teamId: string, userId: string): string => `${teamId}:${userId}`

/**
 * Only the owning process can read or write this file. `enrolment.ts` does
 * not need this — a preference is not worth restricting — but a token is a
 * credential the moment it touches disk, and the default mode a new file
 * gets is whatever the process umask leaves it, which on a shared host can
 * be group- or world-readable. `0o600` is asserted explicitly on every write
 * rather than assumed from the umask in effect when the process started.
 */
const FILE_MODE = 0o600

/**
 * The file as it exists right now, or nothing at all.
 *
 * A missing file is not an error to report — it is the state of every
 * installation nobody has connected a Slack account to yet, the same way a
 * missing enrolment file means nobody has run `/brissa`. Any other read
 * failure is left to throw, but never with the file's own contents folded
 * into the message: this file holds credentials, and an error is exactly
 * the kind of place they leak into a log nobody meant to write one to. Only
 * the path is safe to say out loud.
 */
/**
 * Encrypted at rest, and it is worth being exact about what that buys.
 *
 * The file is `0600` on a volume Fly encrypts, which already stops another
 * process on the box and anyone reading the disk. What it does not stop is a
 * volume snapshot, a backup, or a copy of the file taken by anything that can
 * read it — and those travel. A key that lives in the environment and never on
 * the volume means a file taken without the environment is a file of noise.
 *
 * It does **not** protect against anything that compromises the running
 * process: that has the key by definition. Nobody should read this and think
 * otherwise, which is why it is written here rather than in a release note.
 *
 * AES-256-GCM, a fresh nonce per write, and the tag verified on read — so a
 * file edited by hand fails to decrypt rather than decrypting to something
 * else.
 */
interface Sealed {
  readonly v: 1
  readonly iv: string
  readonly tag: string
  readonly body: string
}

function seal(key: Buffer, plain: string): Sealed {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), body: body.toString('base64') }
}

function unseal(key: Buffer, sealed: Sealed): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(sealed.body, 'base64')), decipher.final()]).toString('utf8')
}

async function readAll(path: string, key: Buffer): Promise<OnDisk> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }

  let sealed: Sealed
  try {
    sealed = JSON.parse(raw) as Sealed
  } catch {
    throw new Error(`Corrupt token store at ${path}`)
  }

  try {
    return JSON.parse(unseal(key, sealed)) as OnDisk
  } catch {
    // The key changed, or the file was tampered with, and from here the two are
    // indistinguishable — which is the point of the tag. Named by path only:
    // whatever is in there stays in there.
    throw new Error(`Token store at ${path} could not be decrypted`)
  }
}

/**
 * Write to a temporary path, then rename over the real one — atomic for the
 * same reason `enrolment.ts` needs it to be: a rename onto an existing path
 * is a single filesystem step, so a crash mid-write leaves the file exactly
 * as it was before, never a truncated mix of old and new. Writing `path`
 * directly would let a process that dies between the first byte and the
 * last leave a half-written credential file behind for the next read to
 * trip over.
 *
 * The temporary file is created `0600` directly, rather than written first
 * and `chmod`-ed after: a mode change is a second step a crash can land
 * between, and the whole point of this function is that a crash mid-write
 * must never produce a file anyone but this process can read.
 */
async function writeAll(path: string, contents: OnDisk, key: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  // Unique per call so two writes racing in the same process never share a
  // temporary file and clobber each other before either gets to rename.
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  const sealed = seal(key, JSON.stringify(contents))
  await writeFile(tmp, JSON.stringify(sealed, null, 2), { encoding: 'utf8', mode: FILE_MODE })
  // Belt and braces: `writeFile`'s `mode` only applies when it creates the
  // file, so a leftover temp path from a previous run with a different mode
  // would otherwise survive. Renaming preserves whatever mode is on the file
  // at rename time, so this has to happen before the rename, not after.
  await chmod(tmp, FILE_MODE)
  await rename(tmp, path)
}

/**
 * `read`, `write` and `forget` all go through the file, not a cache kept in
 * memory — the same discipline `enrolment.ts` states: the same question
 * asked twice must get the same answer.
 */
export function createFileTokens(path: string, keyMaterial: string): Tokens {
  // Thirty-two bytes, and refused rather than padded. A short key silently
  // stretched is a file that looks encrypted and is not, and nothing later
  // would ever say so.
  const secretKey = Buffer.from(keyMaterial, 'base64')
  if (secretKey.length !== 32) {
    throw new Error('BRISSA_TOKENS_KEY must be 32 bytes, base64 encoded — generate one with: openssl rand -base64 32')
  }

  let writes: Promise<void> = Promise.resolve()

  return {
    async read(teamId: string, userId: string): Promise<UserTokenRecord | undefined> {
      const all = await readAll(path, secretKey)
      return all[key(teamId, userId)]
    },

    async write(record: UserTokenRecord): Promise<void> {
      // Serialised for the reason `enrolment.ts` measured rather than
      // guessed at: two connections completing in the same moment both read
      // the same file, both add themselves to their own copy, and the
      // second rename wins — so one of them is told "connected" and is not.
      // Measured before this line existed: two concurrent writes, one
      // record left on disk.
      //
      // A promise chain covers one process, which is what runs today. Two
      // machines writing the same file would need a lock, and this is the
      // line that has to change when there are two.
      writes = writes.then(async () => {
        const all = await readAll(path, secretKey)
        // Read-modify-write, not overwrite-with-one-row: everybody else
        // already on file has to survive a write that is about somebody
        // else entirely.
        all[key(record.teamId, record.userId)] = record
        await writeAll(path, all, secretKey)
      })
      return writes
    },

    async forget(teamId: string, userId: string): Promise<void> {
      // Chained onto the same queue as `write`, not a separate one: a
      // disconnect racing a connect must resolve in whichever order they
      // were actually called, not in whatever order two independent queues
      // happened to schedule them.
      writes = writes.then(async () => {
        const all = await readAll(path, secretKey)
        delete all[key(teamId, userId)]
        await writeAll(path, all, secretKey)
      })
      return writes
    },
  }
}
