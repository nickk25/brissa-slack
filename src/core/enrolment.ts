/**
 * The port through which somebody tells Brissa which languages they read.
 *
 * Declared alongside `directory.ts` and `history.ts`, and for the same reason:
 * the core owns the shape of the question, and an interface declared in the
 * module that answers it — `src/store/enrolment.ts` — would let that module's
 * vocabulary, a file path or a row, cross back one field at a time.
 *
 * Unlike `Directory`, this port **writes**, and that needs its own argument
 * rather than a quiet exception to the rule stated there. `directory.ts` warns
 * that a port with a write method on it is a port that will grow a
 * transaction — a business rule in `src/core` deciding, on its own, that a
 * fact should change. That risk does not apply here, because there is no rule
 * in `src/core` that ever calls `write`, and there will not be one: the fact
 * this port holds is not computed from anything else Brissa knows, it is
 * declared, by the one person it is about, in the same breath as the request
 * that reads it back to them. Writing is not a side effect this port
 * tolerates; it is the entire feature. A read-only version of `Enrolment`
 * would not be a smaller version of this port, it would be a different
 * feature — the one `src/app/config.ts` already serves from a `.env` file,
 * which is the exact thing this port exists to replace.
 *
 * Every record is keyed by `(teamId, userId)` from the first line, though
 * today there is exactly one workspace and the pair looks redundant next to
 * `userId` alone. It is a column now and a migration later: Slack signs every
 * command and interaction with a `team_id` right alongside the `user_id`, so
 * the fact is already there for the taking. A schema that ignores it now is a
 * migration that has to invent a value for every row already on disk, for a
 * fact nobody recorded because nobody thought to ask.
 */

import type { Language } from './ports.ts'

/**
 * One person's own account of what they read, or that they asked Brissa to
 * stop translating for them.
 */
export interface EnrolmentRecord {
  readonly teamId: string
  readonly userId: string
  /**
   * The languages this person reads, in the order they prefer — the same
   * convention `Reader.reads` states in `ports.ts`: `reads[0]` is the
   * language a translation is made into.
   *
   * Empty means **off**. `shouldAsk` already reads an empty list as "reads
   * nothing" and stays silent for that reader, which is exactly the behaviour
   * "stop translating for me" needs — no second code path, no new skip
   * reason. It is not the same answer as never having enrolled at all; that
   * one is `undefined`, one level up, where there is no record to return.
   */
  readonly reads: readonly Language[]
}

/**
 * Read one person, write one person. Nothing here reads or writes more than
 * that — a method that took no key and returned everyone would be a second
 * `Directory`, answering a question this port does not ask.
 */
export interface Enrolment {
  /**
   * What this person has told Brissa, or `undefined` if they never have.
   *
   * `undefined` and a record whose `reads` is empty are deliberately
   * different answers, not two spellings of the same "nothing to report":
   * one means "we have never met", the other means "we have, and they said
   * stop". Collapsing them would make `/brissa off` indistinguishable, on the
   * next query, from never having enrolled at all.
   */
  read(teamId: string, userId: string): Promise<EnrolmentRecord | undefined>
  /** Replaces whatever this person had on file with `record`. */
  write(record: EnrolmentRecord): Promise<void>
}
