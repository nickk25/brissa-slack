/**
 * Who reads what, written by the people themselves, kept on disk.
 *
 * This module answers `src/core/enrolment.ts`: read one person, write one
 * person. Unlike `memory.ts`, the fact here does not arrive as a literal at
 * startup — it changes every time somebody runs `/brissa`, from a process
 * that may not be the one that started, so it has to survive past one
 * process's memory. A JSON file is the smallest thing that survives that; a
 * real database is a schema, a migration and a connection pool guarding a
 * file this small.
 *
 * The path is a parameter, not `process.env.SOMETHING`. Only `src/app/main.ts`
 * reads the environment — every other module is testable without one, and a
 * store that reached past its own caller for a path would be the one exception
 * nobody could find by reading the import list.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ChannelView, Directory } from '../core/directory.ts'
import type { Enrolment, EnrolmentRecord } from '../core/enrolment.ts'
import type { ChannelPolicy, Reader } from '../core/ports.ts'

/** One row per `(teamId, userId)`, the same key `EnrolmentRecord` is declared by. */
type OnDisk = Record<string, EnrolmentRecord>

const key = (teamId: string, userId: string): string => `${teamId}:${userId}`

/**
 * The file as it exists right now, or nothing at all.
 *
 * A missing file is not an error to report — it is the state of every
 * installation that has never had anybody run `/brissa` yet, the same way an
 * empty `BRISSA_READERS` is the honest first state for `src/app/config.ts`.
 * Any other read failure (a permissions problem, a directory where a file
 * should be) is not this module's to paper over, so it is left to throw.
 */
async function readAll(path: string): Promise<OnDisk> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as OnDisk
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
}

/**
 * Write to a temporary path, then rename over the real one.
 *
 * A rename onto an existing path is atomic on every filesystem Node runs on:
 * a reader either sees the file that was there before or the file that is
 * there now, never a half-written mix of the two. Writing `path` directly
 * would let a crash between the first byte and the last leave a truncated
 * file behind — and a truncated JSON file does not fail loudly, it fails the
 * next time anybody reads it, for everybody who was ever enrolled, not just
 * whoever was mid-write.
 */
async function writeAll(path: string, contents: OnDisk): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  // Unique per call so two writes racing in the same process never share a
  // temporary file and clobber each other before either gets to rename.
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  await writeFile(tmp, JSON.stringify(contents, null, 2), 'utf8')
  await rename(tmp, path)
}

/**
 * `read` and `write` both go through the file, not a cache kept in memory —
 * the same discipline `createMemoryDirectory` states for its own lookups: the
 * same question asked twice must get the same answer, and a cache that can
 * drift from what is actually on disk is exactly the kind of hidden state
 * that rule exists to rule out.
 */
export function createFileEnrolment(path: string): Enrolment {
  let writes: Promise<void> = Promise.resolve()

  return {
    async read(teamId: string, userId: string): Promise<EnrolmentRecord | undefined> {
      const all = await readAll(path)
      return all[key(teamId, userId)]
    },

    async write(record: EnrolmentRecord): Promise<void> {
      // Serialised, and the reason is a measurement rather than a worry. Two
      // people typing `/brissa` in the same moment both read the same file,
      // both add themselves to their own copy, and the second rename wins — so
      // one of them is told "saved" and is not. Tried before this line existed:
      // two concurrent writes, one record left on disk.
      //
      // A promise chain covers one process, which is what runs today. Two
      // machines writing the same file would need a lock, and this is the line
      // that has to change when there are two.
      // The queue has to survive a link breaking, and `writes = writes.then(...)`
      // does not: once one write rejects, every later `.then` skips its callback
      // and re-throws the *first* error. A transient EACCES or ENOSPC on the
      // volume would disable writing for the life of the process, long after the
      // disk recovered, and without a word.
      //
      // Measured rather than feared: a read-only directory for one write,
      // permissions restored, and the next write still failed with the stale
      // error.
      //
      // So what is carried forward forgets, and the caller keeps the promise
      // that still knows how its own write went.
      const queued = writes.catch(() => {}).then(async () => {
        const all = await readAll(path)
        // Read-modify-write, not overwrite-with-one-row: every other person
        // already on file has to survive a write that is about somebody else
        // entirely.
        all[key(record.teamId, record.userId)] = record
        await writeAll(path, all)
      })
      writes = queued.catch(() => {})
      return queued
    },
  }
}


export interface FileDirectoryContents {
  /** The channels somebody has switched Brissa on in. */
  readonly channels?: readonly ChannelPolicy[]
  /** What to say about a channel nobody has ruled on. Defaults to disabled. */
  readonly unknownChannels?: 'enabled' | 'disabled'
}

/**
 * The same question `memory.ts` answers, asked of the file people write to.
 *
 * This exists because the two halves used to be strangers. `/brissa` wrote a
 * record here and `Directory` was built once at boot from `BRISSA_READERS`, an
 * environment variable — so enrolling saved something nothing read. Worse than
 * silent: a bare `/brissa` reads this file and reported languages that were not
 * the ones deciding anything, so the command and the behaviour could each be
 * right about a different fact. Somebody was told "Saved" and served as though
 * they had said something else, and there was no way to see it from inside
 * Slack. `src/store/CLAUDE.md` said this file was where that change would land.
 *
 * Read per lookup rather than cached, for the reason stated above `createFileEnrolment`
 * and restated here because this is the hot path and a cache is the tempting
 * thing to add: the same question asked twice must get the same answer, and
 * somebody who has just run `/brissa` must be served on the very next message,
 * not on the next restart. The file is one small JSON object; `writeAll` renames
 * atomically, so a reader sees the file before or the file after, never a torn
 * one.
 *
 * The team is deliberately ignored. Records are keyed `(teamId, userId)`, but
 * `Directory.lookup` is given a channel and nothing else, and one bot token
 * serves one workspace — so every record in the file belongs to the installation
 * asking. That holds until Brissa is installed twice, and `INV-store-43` is what
 * fails on the day it stops holding, rather than a person in one workspace being
 * served for a channel in another.
 *
 * Readers are not filtered by channel here either — the limitation `memory.ts`
 * states, for the same reason and with the same remedy.
 */
export function createFileDirectory(path: string, contents: FileDirectoryContents = {}): Directory {
  const fallback = contents.unknownChannels === 'enabled'
  const policies = new Map((contents.channels ?? []).map((p) => [p.channelId, p]))

  return {
    async lookup(channelId: string): Promise<ChannelView> {
      const policy = policies.get(channelId) ?? { channelId, enabled: fallback }

      // Somebody who ran `/brissa off` is on file with an empty `reads`, and
      // comes back as a reader who reads nothing rather than as nobody. That is
      // what keeps `shouldAsk`'s `reader-reads-nothing` distinct from never
      // having met them — dropping them here would erase the difference the
      // record was written to hold.
      const rows = Object.values(await readAll(path))
      const readers: Reader[] = [
        ...new Map(rows.map((r): [string, Reader] => [r.userId, { userId: r.userId, reads: r.reads }])).values(),
      ]

      return { policy, readers }
    },
  }
}
