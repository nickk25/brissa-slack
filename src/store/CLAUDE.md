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
