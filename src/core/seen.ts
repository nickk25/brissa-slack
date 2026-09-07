/**
 * The port that answers "have we already handled this delivery?".
 *
 * Declared here with the other ports, and for the same reason, though what it
 * guards is not a product rule at all: it is the difference between one
 * translation and two copies of it.
 *
 * Slack redelivers an event whenever the endpoint does not answer quickly enough
 * or answers with anything but a 2xx — which is exactly when something is already
 * going wrong. `chat.postEphemeral` has no idea it has posted before, so without
 * this a bad minute becomes every reader receiving the same translation three
 * times.
 *
 * Asynchronous on purpose. In one process this is a set in memory and the
 * `Promise` is free; the moment there are two processes it has to be something
 * both of them can see, and a signature that had to change then would take every
 * caller and every test with it.
 */
/**
 * Two things every implementation has to keep, and neither is visible in the
 * signature. They are written here because the first store to get one wrong will
 * be a distributed one, and no test in this repository would fail.
 *
 * **Atomic.** Asking and recording are one step. A store that reads, then
 * writes, answers `true` twice for two deliveries that arrived together — which
 * is exactly the case this exists for, since Slack's retry can overlap the
 * original.
 *
 * **Recorded before the work, not after.** That is deliberate and it has a cost
 * worth naming: the edge answers Slack before the translation is attempted, so
 * Slack only ever retries when the acknowledgement itself was late — never when
 * the work failed. Suppressing that retry is right, because the original is
 * still in flight. But with a store that survives a crash, a process that dies
 * between recording and finishing loses the message for good. The fix, when it
 * matters, is a lease with an expiry rather than a bare set.
 */
export interface Seen {
  /**
   * True the first time an id is offered, false every time after.
   *
   * Recording is part of asking. A `check` that leaves the caller to record
   * separately is a check that says yes twice whenever anyone forgets, and the
   * one place it would be forgotten is the error path.
   */
  firstTime(id: string): Promise<boolean>
}
