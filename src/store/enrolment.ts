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
import type { Enrolment, EnrolmentRecord } from '../core/enrolment.ts'

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
  return {
    async read(teamId: string, userId: string): Promise<EnrolmentRecord | undefined> {
      const all = await readAll(path)
      return all[key(teamId, userId)]
    },

    async write(record: EnrolmentRecord): Promise<void> {
      const all = await readAll(path)
      // Read-modify-write, not overwrite-with-one-row: every other person
      // already on file has to survive a write that is about somebody else
      // entirely.
      all[key(record.teamId, record.userId)] = record
      await writeAll(path, all)
    },
  }
}
