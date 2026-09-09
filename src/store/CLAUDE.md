# src/store — contract

The module that owns where "who reads what" comes from.

## Purpose

Answer one question: given a channel, what is Brissa allowed to do there and
whom is it translating for. That question is declared as the `Directory` port in
`src/core/directory.ts`; this module implements it.

## Why there is no database here

There is no schema, no migration and no connection pool, because the fact being
served currently changes when one person edits one config file. A database would
be four moving parts guarding a literal.

The map at the repository root once called this "the only module that talks to
the database". It talks to memory. When that stops being enough the port does not
change — which is the entire reason the port exists — and this file is where the
change lands.

## What it does not do

**Decide anything.** A disabled channel still reports its readers. Filtering them
out here would look like an optimisation and would in fact move a product rule
out of `shouldAsk`, where the corpus and the eval can reach it, into a lookup
where neither can.

**Ask Slack anything.** See below.

## The limitation to state out loud

Readers are not filtered by channel. Every enrolled reader is returned for every
channel.

"Who reads what" is this module's fact. "Who is in this channel" is Slack's, and
the repository's dependency rules put that call in `src/slack`. So Slack's own
`user_not_in_channel` is what removes the readers who are not there —
`src/slack/send.ts` already keeps that outcome distinct from a failure, which is
exactly what makes this workable.

The cost is one send attempt per enrolled reader per translated message. That is
fine for one workspace and is not fine for a hundred. When it stops being fine
the fix is a `Directory` implementation in `src/app` composing this module with a
membership call — **not** a Slack import added here.

## Invariants

- A channel somebody decided about comes back as they decided. `test: INV-store-01`
- A channel nobody decided about is disabled rather than absent, so no caller has
  to check for undefined to find out whether to stay quiet. `test: INV-store-02`
- What an undecided channel defaults to is the caller's choice rather than this
  module's: Brissa is sold as working everywhere at once, and everything else
  here says silence is the default. Both are defensible, so the code does not
  pick one quietly. `test: INV-store-03`
- A disabled channel still reports its readers; the store answers what is, and
  deciding what that means belongs to `shouldAsk`. `test: INV-store-04`
- A directory that knows nobody answers rather than fails. It is the state of
  every workspace on its first day, and a throw would make "not set up yet"
  arrive as an incident. `test: INV-store-05`
- A reader listed twice is one reader. Two entries would send one person the same
  translation twice, and the duplicate would look like a bug in the translator
  rather than in a list. `test: INV-store-06`
- Every enrolled reader comes back for every channel, because channel membership
  is Slack's fact and this module does not pretend to know it. `test: INV-store-07`
- The same question asked twice gets the same answer: no hidden state and no
  cache that can go stale between two reads about one message. `test: INV-store-08`

## Deliveries already handled

`seen.ts` answers `src/core/seen.ts`, and what it guards is not a product rule:
it is the difference between one translation and three copies of it.

Slack redelivers an event whenever the endpoint does not answer quickly enough or
answers with anything but a 2xx — which is exactly when something is already
going wrong. `chat.postEphemeral` has no idea it has posted before, so a bad
minute would otherwise become every reader receiving the same translation
repeatedly.

It is bounded, because the alternative is a process whose memory grows with every
message the workspace has ever sent. Insertion order is the eviction order, and
that is not an LRU pretending to be one: an id offered twice is a **duplicate**,
not a use, so nothing here is ever touched a second time in a way that should
keep it alive longer.

The one way it can be wrong is capacity: an id evicted while its retry is still
coming would look new. That is a sizing question rather than a correctness one —
the bound has to outlast Slack's retry window, and ten thousand ids is minutes of
traffic for any workspace this will see before there is a shared store.

- A delivery is new exactly once. `test: INV-store-09`
- Recording is part of asking. A check the caller has to follow with a separate
  record says yes twice whenever anyone forgets, and the place it would be
  forgotten is the error path — which is exactly where retries come from.
  `test: INV-store-10`
- It forgets the oldest, and only the oldest. The survivors are checked before
  the evicted one, and that order is the whole assertion: asking about an evicted
  id re-inserts it and evicts the next in passing, so a store dropping two per
  overflow would otherwise be indistinguishable. `test: INV-store-11`
- Asking again does not keep an id alive longer. `test: INV-store-12`

## Enrolment: the one write this module does

`enrolment.ts` answers `src/core/enrolment.ts`, and it is a different shape from
everything above it in this file for a reason worth stating plainly: `Directory`
is read-only, served from a literal handed in at startup, and this port writes,
served from a JSON file that changes every time somebody runs `/brissa`. The
justification for the write lives on the port itself, not here — this file only
has to keep the two promises the port makes: the difference between "never
enrolled" and "off" survives a round trip, and a crash cannot lose everybody
else's record to fix one person's.

The path is a constructor parameter, never `process.env` read from inside this
module — the same rule `memory.ts` states by never importing anything that
would let it. Only `src/app/main.ts` reads the environment.

**Atomic, the same way `seen.ts` is bounded: because the alternative is a
correctness bug nobody notices until it happens.** Every write goes to a
temporary path first and is renamed onto the real one — a rename Node's
filesystems perform as a single step, so a crash mid-write leaves the file
exactly as it was before, never half of the old contents and half of the new.
Writing the real path directly would let a process that dies between the first
byte and the last leave a truncated file behind, and a truncated JSON file does
not fail loudly for the person who was mid-write — it fails the next read, for
everybody who was ever enrolled.

**Read-modify-write, not overwrite-with-one-row.** Every write reads the whole
file, updates one entry keyed by `(teamId, userId)`, and writes the whole file
back — because the file holds everybody, and a write about one person must not
be the reason another person's record vanishes.

**A missing file is not an error.** It is the state of every installation that
has never had anybody run `/brissa`, the same way an empty `BRISSA_READERS` is
the honest first state for `src/app/config.ts` — reported as "nobody enrolled
yet" rather than thrown.

- A person who has never enrolled reads back as `undefined`, not an error and
  not an empty record. `test: INV-store-13`
- What was written is what comes back, keyed by team and user together — the
  same user in two different teams is two different records. `test: INV-store-14`
- `off` — a written record whose `reads` is empty — round-trips as a real
  record, distinguishable from never having enrolled at all. `test: INV-store-15`
- A store nobody has ever written to answers "nobody enrolled yet", not an
  error. `test: INV-store-16`
- Writing one person leaves another person, already on file, untouched.
  `test: INV-store-17`
- A write that fails before it renames leaves the previous file exactly as it
  was — the whole reason the write goes to a temporary path first.
  `test: INV-store-18`
- Two people enrolling at the same moment both stay enrolled. A read-modify-write
  pair that overlap take the same photograph of the file, each add themselves to
  their own copy, and the second rename wins — so the person who lost is told
  "saved" and is not, discovering it only when Brissa never translates for them.
  Measured before the fix: two concurrent writes, one record on disk. Serialising
  covers one process, which is what runs today; two machines writing one file
  would need a lock, and that is the line to change when there are two.
  `test: INV-store-19`

## Tokens: the one write that is not safe to log

`tokens.ts` answers a port shaped like `Enrolment`'s — read one person, write
one person, keyed by `(teamId, userId)` — but it is not the same file, and it
is not a tidiness question. `enrolment.ts` holds a preference somebody would be
happy to have printed in a support channel; `tokens.ts` holds a credential
that lets Brissa act as that person on Slack. Folding them together would mean
every future reader of "who reads what", every backup, every debug dump of one
file, is also a reader of the other. One file, one blast radius, and this one
stays smaller on purpose.

It keeps every promise `enrolment.ts` makes — atomic writes, serialised
writes, a missing file read as "nobody connected yet" rather than an error,
the path arriving as a parameter and never as `process.env` — and adds three
more that a credential needs and a preference does not:

**The file is created `0600`.** `enrolment.ts` does not do this because a
preference is not worth restricting; a token is a credential the instant it
touches disk, and the mode a new file gets otherwise is whatever the process
umask leaves it — on a shared host, that can be group- or world-readable. The
mode is asserted on the temporary file at creation, before the rename, so a
crash mid-write cannot leave behind a file with the wrong permissions.

**Deleting is not optional.** A store that can only add is a store that keeps
a credential after the person it belongs to has withdrawn consent — Slack
revokes are one-way, and Brissa disconnecting has to be too. Deleting a
record that was never there is not an error, the same way `enrolment.ts`
treats a missing file: the end state ("nothing on file") is identical either
way.

**Nothing here logs, returns unprompted, or folds a token into an error
message.** A `console` call is the cheapest place that guarantee leaks from
first, so read, write and delete are spied on end to end and must produce
none — the same shape `INV-app-64` in `src/app/command.test.ts` established
for the port this module was modelled after keeping quiet. A corrupt file is
reported by its path; the raw bytes that failed to parse are never folded
into the thrown error, because an error message is exactly the kind of place
a credential leaks into a log nobody meant to write one to.

- A person who has never connected reads back as `undefined`, not an error.
  `test: INV-store-20`
- What was written is what comes back, keyed by team and user together — the
  same user in two different teams is two different records.
  `test: INV-store-21`
- A store nobody has ever written to answers "nobody connected yet", not an
  error. `test: INV-store-22`
- Writing one person leaves another person, already on file, untouched.
  `test: INV-store-23`
- A write that fails before it renames leaves the previous file exactly as it
  was. `test: INV-store-24`
- Two people connecting at the same moment both keep their tokens — the same
  race `enrolment.ts` measured, on a file that cannot afford to lose either
  side of it. `test: INV-store-25`
- The file on disk is created readable only by the owning process.
  `test: INV-store-26`
- It stays that way across a second write, not just the first — `mode` on
  `writeFile` only applies when the call creates the file, so this is checked
  again rather than assumed. `test: INV-store-27`
- Deleting a person removes them; a later read reports `undefined`.
  `test: INV-store-28`
- Deleting a person who was never connected is not an error.
  `test: INV-store-29`
- Deleting one person leaves another person, already on file, untouched.
  `test: INV-store-30`
- A failure to read a corrupt file reports the path, never the contents that
  failed to parse. `test: INV-store-31`
- Nothing here writes to `console.log`, `console.warn` or `console.error`,
  across a write, a read, a delete, and a corrupt read. `test: INV-store-32`
- A token taken off the disk without the key is noise. `0600` on an encrypted
  volume already stops another process on the box; it does not stop a snapshot,
  a backup, or a copy taken by anything that could read the file — and those
  travel. The key lives in the environment and never on the volume. It buys
  nothing against something that compromises the running process, which has the
  key by definition. `test: INV-store-33`
- A file edited by hand fails to open rather than opening wrong. A store that
  returns a mangled token silently is worse than one that refuses.
  `test: INV-store-34`
- A key that is not a key is refused rather than stretched: a short key quietly
  padded produces a file that looks encrypted and is not. `test: INV-store-35`
- Every file that exists and cannot be used is the same kind of problem, and
  says which path. The startup check refuses to run on that type and rethrows
  anything else — it caught a wrong key and a plaintext file while letting a
  truncated one, an empty one and a directory through to a stack trace, which is
  the unactionable failure it existed to prevent. A file that is simply absent
  is still nobody, not a fault. `test: INV-store-36`

