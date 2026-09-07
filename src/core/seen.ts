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
