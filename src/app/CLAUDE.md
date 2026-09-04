# src/app — contract

The one place every piece meets, and the only module allowed to import them all.

## Purpose

Take a Slack event and carry it to whatever each reader ends up seeing:
`receive` → `lookup` → `shouldAsk` → `translate` → `renderTranslation` →
`sendEphemeral`. That is the whole module. It puts existing pieces in an order
and awaits them.

## What it does not do

**Decide anything, and know no format.** Every judgement belongs to `src/core`
and every payload shape belongs to an adapter — which is why this module asks
`src/slack` for `ephemeralFor` rather than assembling a `chat.postEphemeral`
payload itself. It named `thread_ts` here once; that was a Slack field name
living in the wiring, and it is the shape of every future leak. This module is also where that
stops being enforceable by inspection, because it is the first one permitted to
import from everywhere.

The check is narrow enough to apply without thinking: **if this file ever
contains an `if` about the *content* of a message, the rule it encodes was moved
out of `src/core` and out of reach of the corpus.** The policy check is the
tempting one — an early `if (!policy.enabled) return` here would read as an
optimisation and would in fact duplicate `ask.ts` in the wiring. `shouldAsk`
decides, per reader, and the resulting count of skips is the honest number of
reader–message pairs.

## Grouping, and why the key is ordered

`TranslationRequest` is `{ text, reads }` and carries no reader identity, so two
readers with the same `reads` produce a byte-identical request. One call serves
both. Asking twice pays twice and, worse, can return two different answers for
one message — a difference between two colleagues that no counter could explain.

The key is the **ordered** tuple, not the set: `src/llm/decide.ts` translates
into `reads[0]`, so `['es','en']` and `['en','es']` are different translations
and must not share a call.

Grouping happens strictly **after** `shouldAsk`. Before it, the author of the
message would land in a group with his own recipients, and a reader who has
declared no languages would form a group whose request the translator can only
fail — turning a skip that has a reason into a failure that has a stack trace.

## The outcome has two levels

A flat list of per-reader outcomes makes an empty array mean four different
things: the event was not a message, the channel has nobody enrolled, the lookup
broke, or every reader was skipped. Those are the same silence with four
different owners.

`stage` on a failure is load-bearing rather than decorative: a translate failure
is `src/llm`'s to fix, a send failure is `src/slack`'s. Same word, two owners.

## Two guarantees, and one deliberate non-guarantee

**This never rejects.** Every port call is wrapped, and so is everything between
them: `renderTranslation` runs after one await and before the next, is not a
port, and would otherwise escape as a rejected promise if handed a malformed
`Translation`. The caller is an HTTP handler that has to answer Slack within
seconds whatever happened, and a thrown error there becomes a Slack retry —
which becomes a second copy of every ephemeral, precisely when something is
already wrong.

**The order of outcomes is the order the directory gave.** An order that depended
on which model call returned first would make every assertion about this flaky.

**Deduplication is not this function's job**, and cannot be: Slack's retry count
and event id live in the envelope, which `receive` never sees. It belongs to
whatever answers Slack's request. Called twice with the same event, this honestly
does the work twice, and `INV-app-18` asserts that rather than leaving the
absence to be read later as a bug.

## Invariants

- One message reaches every reader who needed it and nobody else, with the blocks
  `renderTranslation` produced. `test: INV-app-01`
- Readers who read the same languages cost one model call, not one each.
  `test: INV-app-02`
- The same languages in a different order are a different translation, because
  the first is the one translated into. `test: INV-app-03`
- Silence is an answer with a shape rather than an empty list. Restraint is the
  product, so "nothing was sent" must stay distinguishable from "nothing was
  considered". `test: INV-app-04`
- A translation failure is visible, attributed to a stage, and confined to its
  own group. `test: INV-app-05`
- A port that throws becomes an outcome, never a rejected promise.
  `test: INV-app-06`
- A reader who was not in the channel is not a failure, and a refusal is not an
  absence. One is the expected answer for a message that arrived overnight; the
  other is somebody's job. `test: INV-app-07`
- A send that throws is the sending module's failure, not the model's.
  `test: INV-app-08`
- A disabled channel spends nothing at all — no model call, no post — and says so
  once per reader. `test: INV-app-09`
- The author is never posted his own words back, even when he shares a reads
  tuple with real recipients and would therefore land in their group.
  `test: INV-app-10`
- A reader who has declared no languages never reaches the model. This is the
  invariant that pins grouping to *after* `shouldAsk`: such a reader would
  otherwise form a group whose request the translator can only fail.
  `test: INV-app-11`
- A bot message and a message with nothing to read both cost nothing.
  `test: INV-app-12`
- A channel Brissa knows nobody in says so rather than returning an empty list.
  `test: INV-app-13`
- An event that was never a message is rejected by name, before anything is
  looked up. `test: INV-app-14`
- A directory that breaks is reported as a broken directory, never as an empty
  workspace. `test: INV-app-15`
- A translation lands in the thread it belongs to, and a top-level one carries no
  thread at all — absent rather than undefined, which Slack treats as malformed.
  `test: INV-app-16`
- Escaping survives the seam between rendering and sending. `test: INV-app-17`
- The same event twice does the work twice, because deduplication belongs to the
  HTTP edge. `test: INV-app-18`
- The real adapters compose: a Slack event becomes an ephemeral with no fake
  between them but the two edges that would need a network. `test: INV-app-19`
- The reader gets the whole translation and the notification gets a glance of it.
  Two different budgets; one string serving both would either truncate what the
  reader reads or push a paragraph into a notification. `test: INV-app-20`
- Two groups that both need translating each get their own translation, in the
  channel the message arrived in. `test: INV-app-21`
- One reader's send failing does not take down the others in their group.
  `test: INV-app-22`
- Two readers are grouped only when they declared the very same thing. A key
  built by joining would make `['es en']` and `['es','en']` one group, and the
  loser of that collision would be sent a translation into a language they never
  declared — silently, and only for them. `test: INV-app-23`

## Why these tests are different from every other suite here

They are the only ones that can fail because two modules disagree. A per-module
suite cannot see a translation rendered into blocks nobody sends, a skip that
spends a model call anyway, or a refusal counted as a delivery.

So they assert on **what the fakes recorded**, and above all on what they
recorded nothing of. An absence of side effects is not observable any other way,
and it is exactly what the gates could never check: coupling rules and invariant
anchoring control the *shape* of a change, never its behaviour.

`deepEqual` against the whole recorded list, never `.some()` — a test asking
whether the right call happened passes happily while three wrong ones happen
beside it.

`INV-app-19` is the one that fakes only the network edges. Each part it exercises
has its own test elsewhere — `INV-llm-01` and `INV-llm-08` for the adapter,
`INV-core-12` for language names — and what is untested anywhere else is their
**composition**: the JSON the model returns becoming a block a reader can read,
with no fake standing between them.

## Still missing

Everything that turns this function into a running program: the HTTP endpoint,
the Slack signature check, event deduplication, and the config that says who
reads what. `handleMessage` is complete and nothing calls it yet.
