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

## Two ports, and why both are declared here

`translator.ts` asks for a translation. `directory.ts` asks who reads what in a
channel. Neither is called by anything in this module, and both belong here
anyway: the core owns the shape of the question, and an interface declared in the
module that answers it would let that module's vocabulary — a table name, a row,
an SDK type — cross back one field at a time.

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
