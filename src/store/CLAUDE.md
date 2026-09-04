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

## Still missing

Enrolment. Nothing writes to this module — the port is read-only on purpose, and
the contents arrive as a literal at startup. The command a person uses to say
which languages they read does not exist yet, and when it does it is this
module's own API rather than a method on the port.
