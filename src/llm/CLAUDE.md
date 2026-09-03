# src/llm — contract

The only module that may import the Anthropic SDK. Everything else asks it a
question through a port and never learns which model answered.

## Purpose

Turn one Slack message plus the reader's languages into a decision — translate or
stay silent — and, when it translates, the whole message in the reader's
language.

## What it does not do

Decide policy. Whether Brissa is even enabled for this channel, this reader or
this message is `src/core`'s business; by the time a message arrives here the
decision to *ask* has already been made. The only judgement made here is the one
that needs a model to make it.

## The prompt is behaviour

`prompts/decide.md` is not documentation. Changing it changes what the product
does, so `coupling.yaml` requires its eval to have been run — and the recorded
result carries the prompt's hash, so a score from an older prompt cannot pass for
a current one.

Two things in it are load-bearing and easy to lose in an edit:

- **Restraint.** The output appears unprompted in someone's Slack. A translation
  they did not need costs more attention than one they missed, so the tie goes to
  silence. `Danke!` is the case that pins this down, and `Passt bei mir auch!` is
  the case that stops the rule collapsing into "short messages are exempt".
- **The untranslatables.** Code, links, mentions, emoji, product names, numbers
  and dates. Breaking one of these is the most visible way to lose a reader's
  trust, and trust here is binary rather than gradual.

## Calibration

`npm run calibrate -- --model <id>` scores the decision — never the translation
quality — against the answers a person wrote by hand in `fixtures/corpus`. It
exists to turn "the cheap model is enough" into a number, by running the same
corpus through a stronger model as the reference.

Disagreement is the finding, not a failure, so the run exits zero. A case that
could not be measured is recorded as such and never counted as agreement.
