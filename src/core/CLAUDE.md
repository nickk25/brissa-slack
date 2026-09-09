# src/core — contract

The half of Brissa that can be reasoned about without a network.

## Purpose

Decide what to do with a Slack message. Pure: no I/O, no SDK, no clock, no
randomness, and nothing here knows what Slack or a model call looks like.

## What it does not do

**Guess at languages.** Whether a message contains something the reader cannot
read is the model's judgement, because real messages mix languages inside a
single sentence and every heuristic that shortcuts it is wrong in the direction
that matters — staying quiet about the message that mattered. The rules here are
only the ones that need no language knowledge at all.

## Why `shouldAsk` exists

Every message in every enabled channel passes through it and most of them stop.
That is the point twice over: silence is the product, and a message that never
reaches the model costs nothing.

It returns a **reason** rather than a boolean. Silence is the common case here,
not the exception, and an unexplained silence is indistinguishable from a bug.

An earlier version of this line claimed every reason becomes a counter on the
state page. It does not, and nothing did: `npm run state` measures the
*repository* — tests, invariants, coupling, module size — and knows nothing about
messages. The reasons are carried so that whoever asks "why did nothing happen"
gets an answer; where they are counted is still an open question, and a contract
that answered it in advance was a contract stating something false.

## Invariants

- A message worth asking about is asked about. `test: INV-core-01`
- Brissa never asks about its own output; otherwise it translates itself, and
  then translates that. `test: INV-core-02`
- Nobody gets their own words back. `test: INV-core-03`
- A disabled channel is silent before anything else is considered, so a decision
  can never depend on who wrote a message in a channel Brissa was switched off
  in. `test: INV-core-04`
- A reader who has declared no languages is not treated as reading none. The two
  look identical in the data and are opposite in what they should produce.
  `test: INV-core-05`
- A decision to stay quiet always says why. `test: INV-core-06`
- A message with no readable text is not worth a model call. `test: INV-core-07`
- The shortest real word is still readable text: the threshold is two characters,
  because one is a reaction and two is the shortest word a language has.
  `test: INV-core-08`
- Words survive the stripping of everything around them; a mention beside a real
  sentence is still a real sentence. `test: INV-core-09`
- A translation renders as the message and one line of context, nothing more.
  `test: INV-core-10`
- The context says the message is visible to nobody else. `test: INV-core-11`
- Languages are named rather than printed as codes. `test: INV-core-12`
- Several languages read as a list rather than a join. `test: INV-core-13`
- An unknown language code is shown rather than dropped; losing it leaves
  "Translated" with no source, which reads as a bug. `test: INV-core-14`
- The translated text is escaped so Slack cannot re-format it — a stray angle
  bracket in the original must not become markup in the translation.
  `test: INV-core-15`
- Escaping leaves ordinary text untouched. `test: INV-core-16`
- The translation says who wrote the original — as a mention, so Slack renders
  the person's current display name and this module needs no directory, no
  `users:read` scope and no cache of names that go stale. `test: INV-core-17`
- Two foreign messages in a row stay told apart. `test: INV-core-18`
- A long original is a glance rather than a second copy of the message.
  `test: INV-core-19`
- The quoted original cannot mention anybody: it arrives as evidence of what was
  said, never as a re-broadcast — while the author's own mention, which this
  module builds, stays live. `test: INV-core-20`
- A multi-line original is quoted as one line. Slack's `>` quotes to the end of
  the line, so a newline inside would put the rest of the original outside the
  quote bar, where it reads as the translation. `test: INV-core-21`
- The quote is cut at a fixed length, and a message exactly that long is not cut.
  Two off-by-ones live there and neither is visible in a screenshot: whether the
  boundary is inside or outside, and whether the ellipsis replaces a character or
  is added to them. `test: INV-core-22`
- A translation whose source language is unknown still says it was translated;
  otherwise the context line reads "Translated from " and trails off, which looks
  like the bug it is not. `test: INV-core-23`
- The anchor is omitted when there is no source to point at. It exists because an
  ephemeral lands at the bottom of a channel with nothing tying it to the message
  it translates; text somebody just typed into a slash command has no such
  problem, and quoting it back under their own name is the app repeating what
  they said a second ago. `test: INV-core-25`
- A reference in the translation stays a reference, and everything else stays
  inert. The asymmetry with the quote above it is the point: the original arrives
  as evidence of what somebody said and must not become live, while the
  translation is Brissa's own sentence, where a mention is the only part the
  reader could not have guessed — an id that means nothing to a person, which
  Slack renders as a name for free. `test: INV-core-26`
- Only Slack's own reference syntax survives escaping. A loose pattern would hand
  back exactly what escaping exists to prevent. `test: INV-core-27`
- Every notice is one line, and none of them apologises. Notices exist only
  because somebody clicked and there was no translation to show: silence would
  read as a broken button, a paragraph as an incident, and "you can already read
  this" is information rather than a failure. `test: INV-core-24`
- A translation too long for one Slack block is truncated rather than dropped,
  and the cut is named rather than left as a bare ellipsis — a translation that
  just stops reads as the model trailing off, not as a limit in Slack.
  `test: INV-core-28`
- The block limit is counted after escaping, not before. Escaping expands text
  — `&` becomes `&amp;` — so a bound checked on the raw string would let an
  escaped block through that Slack still refuses. `test: INV-core-29`
- A cut never ends inside one of Slack's own references. A `<` with nothing
  closing it is not ordinary text to Slack's parser: an unterminated reference
  can swallow whatever follows, including the line that says the message was cut.
  Twelve of ninety boundary positions did exactly that before the guard existed.
  `test: INV-core-30`

## Why rendering is here and not in the adapter

`render.ts` produces something shaped like a Slack payload, which looks like
adapter work. It is not: how a translation reads is a product decision, and
product decisions that live in an adapter are product decisions nobody tests.

The design pressure is all downward. The output appears unprompted, under
somebody else's message, in a channel shared with a client. A section and one
line of context; no header, no divider, no button. Anything that makes it look
like a separate announcement makes the channel worse than it was.

The context line says two things and both are load-bearing: which language the
message came from, and that nobody else can see this. Without the second, a
first-time reader's reasonable assumption is that the whole channel just watched
a bot translate a colleague for them.

## The anchor, and why it had to be added rather than removed

Everything else in this file is subtraction: no header, no divider, no button.
The anchor is the one element that had to go in.

**An ephemeral does not attach to the message it translates.** It lands at the
bottom of the channel like any other message, only nobody else can see it. One
message alone, that is fine. Two foreign messages in a row produce two
translations sitting together with nothing saying which belongs to which, and
the reader is back to doing the work this product exists to remove.

So each translation carries who wrote the original and enough of their words to
recognise:

```
> @Jens: Passt bei mir auch, ich melde mich…
A mí también me viene bien, te escribo mañana.
Translated from German · only visible to you
```

Three things about that line are decisions rather than formatting:

The author is a `<@U…>` **mention**, not a name. Slack renders it as the
person's current display name, which is why Brissa asks for no `users:read`
scope, keeps no directory, and can never show a name that went stale. A
permission not requested is a permission that cannot leak.

The quote is **escaped and the mention is not**. The original is the one string
in this product written by somebody else, and a mention inside it must arrive as
evidence of what was said rather than as a re-broadcast of it.

The quote is **cut to a glance**, and collapsed to one line. It is there to be
recognised, not read: repeating the whole message above its own translation
doubles the height of something that appeared unprompted in somebody else's
channel. One line also matters mechanically — Slack's `>` quotes to the end of
the line, and a newline would drop the rest of the original outside the quote
bar where it reads as the translation.

## Why every section is bounded

Slack rejects a `section` block over 3000 characters, and rejects the whole
payload it was part of — not just that one block. `/translate 20`
concatenates twenty translations into one reply; before this bound, one long
translation among them failed all twenty, and the caller got `unanswerable`
where nineteen good translations should have been.

**Truncate, do not drop.** A translation cut short still tells the reader most
of what was said. A payload Slack refuses tells them nothing, and it takes
everyone else's translation down with it.

**The cut lands in the translation, never the anchor.** The anchor is a
mention and an 80-character quote (`QUOTE_LIMIT`) — bounded already, a few
dozen characters at most. The translation is the one part with no ceiling of
its own. Trimming the anchor to make room for an oversized translation would
protect the large, disposable half at the expense of the small half that says
*which* message this is — backwards.

**The cut says so.** A translation that just stops mid-sentence reads as the
model losing its thread, not as a limit somewhere else in the pipeline. This
is the same instinct behind `SendOutcome` in `src/slack/send.ts` — `accepted`,
not `delivered` — and behind every notice below: a thing that did not fully
happen has to say so, out loud, in Brissa's own voice. An ellipsis alone does
not do that; a trailing line naming the cut does.

**Counted after escaping.** Escaping expands text — `&` becomes `&amp;`, five
characters for one — so a limit checked before escaping is not the limit
Slack enforces. The bound runs on the string as it leaves this module, after
`escapeKeepingReferences`, not before.

## Three outcomes, not two

`translator.ts` declares the port the core asks a translation through, and it
returns `translated`, `silent` or `failed`. The last two are both "no
translation appeared", and keeping them apart is the point.

Staying quiet is this product's normal behaviour. If an outage read as silence,
the difference between Brissa working perfectly and Brissa being down would be
invisible — to the reader and on the state page. One of the two is the feature;
the other is somebody's job.

The port lives here rather than in `src/llm` so the core owns the shape of the
question. An interface declared in the adapter would let the SDK's vocabulary
cross back one field at a time.

## Six ports, and why all of them are declared here

`translator.ts` asks for a translation. `directory.ts` asks who reads what in a
channel. `seen.ts` asks whether a delivery has already been handled. `history.ts`
asks what was recently said in a channel. `enrolment.ts` reads, and writes, one
person's own account of what they read. `tokens.ts` reads, writes, and revokes
one person's own Slack user token. None of them is called by anything in this
module, and all of them belong here anyway: the core owns the shape of the
question, and an interface declared in the module that answers it would let that
module's vocabulary — a table name, a row, an SDK type — cross back one field at
a time.

`tokens.ts` is the newest of the six, and it is worth saying plainly why it is
not simply `enrolment.ts` with a different field name — its own doc comment
makes the same case at length, and this is the short version. Every other
port here holds a *fact* about a person; getting one wrong loses a preference
or mistranslates a message, once. `tokens.ts` holds a *bearer credential* —
`src/slack/oauth.ts` is where it first arrives, from Slack, and its own
contract states the same discipline from the other direction. Whoever holds
the value this port stores can read every channel the person it belongs to
can read, until that person revokes it themselves. That is not a bigger
version of the mistake `enrolment.ts` risks, it is a different kind of
mistake, and treating it as "one more record keyed by `(teamId, userId)`" is
exactly the reading its own doc comment exists to head off before anything
built on top of it — a log line, an error message, a debug endpoint — gets
the chance to make it.

It also carries a method none of the other five need: `forget`. A stale
language preference costs nothing to leave on file; a dead bearer credential
is the worst thing to leave sitting anywhere, and Slack can end this token's
life — a person disconnecting it from their own app-management page, an
admin deactivating the account — without this store hearing about it any
other way. `write`'s replace-in-place semantics have no way to say "and now
there is nothing here"; `enrolment.ts` can say that with an empty `reads`
because a list has an empty state, and a bearer token does not.

`enrolment.ts` is the one port here that writes, and it earns that only because
of what it is: a person's own declaration of a fact about themselves, made
through `/brissa` and nothing else. `directory.ts`'s own doc comment states the
risk a write method invites — a business rule in `src/core` deciding, on its
own, to mutate state nobody asked it to touch — and that risk has no purchase
here, because no function in this module calls `write`. Every record is keyed
by `(teamId, userId)` from the start, a pair Slack already signs onto every
command and interaction, so the day a second workspace exists it costs a column
nobody has to invent retroactively.

`history.ts` exists for `/translate`, which has to decide which of several
recent messages to act on — skip the caller's own, take the last N — before it
can even ask for a translation. That is a judgement about data, the same kind
`shouldAsk` makes, so its shape is declared here rather than in
`src/slack/history.ts`, which only answers it. Its own read-only contract, and
why it must never throw, are documented on the port itself rather than repeated
here.

`seen.ts` is the odd one, and it is worth saying why it is a port at all. What it
guards is not a product rule: it is the difference between one translation and
three copies of it, when Slack redelivers an event because the endpoint was slow.
It is asynchronous for a reason that has not arrived yet — in one process it is a
set in memory and the `Promise` is free, but the moment there are two processes it
has to be something both can see, and a signature that changed then would take
every caller and every test with it.

Two rules of `seen.ts` are stated in the port because its signature cannot carry
them, and because the first store to get one wrong will be a distributed one, by
which point no test in this repository would fail.

**Asking and recording are one atomic step.** A store that reads and then writes
answers "new" twice for two deliveries that arrived together — which is precisely
the case the port exists for, since Slack's retry can overlap the original.

**Recording happens before the work, not after**, and the cost of that is worth
naming rather than discovering. The edge answers Slack before attempting the
translation, so Slack only ever retries when the acknowledgement was late — never
when the work failed. Suppressing that retry is correct, because the original is
still in flight. But with a store that survives a crash, a process dying between
recording and finishing loses the message for good. The fix, when it matters, is
a lease with an expiry rather than a bare set.

The rule that keeps this honest is narrow and absolute: **no function in
`src/core` ever takes a port as a parameter.** `shouldAsk`, `hasNothingToRead`,
`renderTranslation` and `escapeMrkdwn` are synchronous and take data. The first
time one of them accepts a `Directory` so it can be "tested properly", the core
has a clock and the boundary is decoration.

A `Promise` in an interface is not I/O. Declaring one costs this module nothing;
awaiting one would cost it everything, and `src/app` is what awaits.

## Cost note

`hasNothingToRead` is the only place where being wrong is cheap in one direction
and expensive in the other. A false "nothing to read" loses a message silently; a
false "something to read" costs one model call. Prefer asking.
