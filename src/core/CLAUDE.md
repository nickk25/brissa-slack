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
not the exception, and an unexplained silence is indistinguishable from a bug —
every reason becomes a counter on the state page.

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

## Cost note

`hasNothingToRead` is the only place where being wrong is cheap in one direction
and expensive in the other. A false "nothing to read" loses a message silently; a
false "something to read" costs one model call. Prefer asking.
