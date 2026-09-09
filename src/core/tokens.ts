/**
 * The port through which Brissa reads and writes one person's own Slack user
 * token — the credential `/translate` needs so that reading a channel's
 * history happens under the caller's own identity, in channels they already
 * belong to, instead of under the identity of whoever first set Brissa up.
 * `src/slack/CLAUDE.md`, "The slash command, and the other credential",
 * records why that read cannot go through the bot token at all; this port is
 * what lets more than one person hold that answer at once.
 *
 * Declared alongside `directory.ts` and `enrolment.ts`, for the same reason:
 * the core owns the shape of the question, and an interface declared in the
 * module that answers it — wherever these records end up stored — would let
 * that module's vocabulary, a table name, a row, a KMS key id, cross back one
 * field at a time.
 *
 * **This is not another `enrolment.ts`, and reading it as one is the mistake
 * this comment exists to head off.** Every other port in `src/core` holds a
 * *fact* about a person — a language preference, a channel policy — and
 * getting one wrong loses a preference or mistranslates a message once.
 * `Tokens` holds a *bearer credential*: whoever holds `token` can read every
 * channel the person it belongs to can read, exactly as they could, until
 * that person revokes it from Slack's own app-management pages. Losing one of
 * these is not a bug report, it is an incident. So every caller of this port
 * — and everything upstream of it, all the way to `src/slack/oauth.ts`, which
 * is where the token this port stores first arrives — is held to a bar
 * `directory.ts` and `enrolment.ts` never had to state:
 *
 * - **Never log a `UserTokenRecord`, in whole or in part, at any level.** A
 *   debug line that prints "the record we just wrote" is a debug line that
 *   prints a working Slack credential into whatever aggregates logs.
 * - **Never let one appear in an error message, a returned `detail`, or a
 *   thrown stack.** A `Tokens` implementation that reports "failed to write
 *   token xoxp-... for U123" has turned a storage fault into a leak.
 * - **Never serialise one into a response a browser, a Slack payload, or a
 *   third party could carry back to somebody other than the person it
 *   belongs to.** The token travels from Slack to this port and no further.
 *
 * Read, write, and revoke, mirroring `enrolment.ts`'s own justification for
 * why a write here is not the mistake `directory.ts` warns against: the fact
 * this port holds is not computed from anything else Brissa knows, it is
 * handed over once, by the one person it is about, at the end of an OAuth
 * flow they themselves started. No function in `src/core` calls `write` or
 * `revoke`; nothing here has an opinion about *when* a token should change,
 * only a place to put one, and a way to take it out, once somebody else has
 * decided that it should.
 *
 * `revoke` earns its place for a reason `enrolment.ts` never had to answer:
 * a language preference costs nothing to leave on file forever, and a dead
 * bearer credential is the worst thing to leave sitting anywhere. Slack
 * itself can end this token's life without telling this port — a person
 * revoking it from their own app-management page, an admin deactivating the
 * account — and whatever wires this flow together needs a way to make this
 * store agree, whether it hears that from Slack's `tokens_revoked` event or
 * from the person asking directly. `write`'s replace-in-place semantics have
 * no way to express "and now there is nothing here": `enrolment.ts` can say
 * that with an empty `reads` because a list has an empty state; a bearer
 * token does not, and inventing an empty-string sentinel for one would just
 * move this exact warning onto whichever caller has to remember to check it.
 *
 * Keyed by `(teamId, userId)` from the first line, the same pair
 * `enrolment.ts` and `directory.ts` already use and for the same reason:
 * Slack signs both onto every command and interaction already, so the day a
 * second workspace exists this costs a lookup, not a migration that has to
 * invent a `teamId` for every row already on disk.
 */

/**
 * One person's own Slack user token, and whose it is.
 *
 * `token` is the entire reason this type exists and the entire reason it is
 * dangerous — see the module comment above before adding a second place that
 * reads or writes one.
 */
export interface UserTokenRecord {
  readonly teamId: string
  readonly userId: string
  readonly token: string
}

/**
 * Read one person's token, write one person's token, revoke one person's
 * token. Nothing here reads or writes more than that — a method that took
 * no key and returned every record on file would be a second `Directory`,
 * answering a question this port has no business being asked, over a
 * credential that has no business ever appearing in a list.
 */
export interface Tokens {
  /** What this person authorised, or `undefined` if they never have. */
  read(teamId: string, userId: string): Promise<UserTokenRecord | undefined>
  /** Replaces whatever this person had on file with `record`. */
  write(record: UserTokenRecord): Promise<void>
  /**
   * Removes whatever this person had on file, if anything. Idempotent:
   * revoking somebody who was never enrolled, or revoking twice, is not an
   * error — both leave the same "nothing on file" this port already treats
   * as ordinary, the same answer `read` gives someone who never authorised
   * at all.
   */
  revoke(teamId: string, userId: string): Promise<void>
}
