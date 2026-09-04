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

## The adapter

`decide.ts` answers the port declared in `src/core/translator.ts`, and nothing
else crosses back: no SDK type, no token count, no model name. The core asked a
question about a message and gets an answer about a message.

The prompt is read from disk rather than inlined, so exactly one copy exists. The
eval measures the same bytes this ships; a prompt that drifted from the one that
was scored would be a prompt with no score.

Transient failures are retried and refusals are not. Overload and rate limiting
are the service saying "not now"; a 400 is it saying "no", and repeating a
request it already refused only delays the report of a real problem while
spending money.

Two answers are treated as broken rather than quiet, because both wear the shape
of silence: a model that chose to translate and returned no text, and a reader
with no declared languages. Reporting either as silence would hide a fault behind
the product's own normal behaviour.

## Invariants of the adapter

- A translation comes back as one, with the languages it found. `test: INV-llm-01`
- A decision not to translate is silence, not a failure. `test: INV-llm-02`
- Silence and failure are never the same outcome. `test: INV-llm-03`
- Asked to translate but given no text is a failure. `test: INV-llm-04`
- A transient failure is retried and can still succeed. `test: INV-llm-05`
- A refusal is not retried. `test: INV-llm-06`
- Retrying gives up rather than looping forever. `test: INV-llm-07`
- The reader's languages reach the model by name, not as codes — the prompt is
  written in English about languages and `de` is not a word it can reason about.
  `test: INV-llm-08`
- A reader with no languages is a failure, never a guess, and costs nothing to
  find out. `test: INV-llm-09`

## Invariants the mutation report asked for

This module scored 59.09% when mutation testing was first wired up — the worst
in the repository, in the one file where a fault costs a reader their message.
Forty-five mutants survived, and nearly all of them lived in the request itself:
nothing had ever looked at what was actually sent.

- The request carries the schema that makes the answer parseable at all. Without
  `output_config` the model answers in prose, every parse fails, and it fails
  *silently* — as "model returned no text", for every message.
  `test: INV-llm-10`
- The message reaches the model as the message, unaltered. `test: INV-llm-11`
- Exactly `500` is the service saying "not now" rather than "no". The boundary,
  not a number near it: `>= 500` and `> 500` differ on one status code, and it is
  the most common server error there is. `test: INV-llm-12`
- A reply with no text block is a failure that says so, not silence — silence is
  the product working correctly. `test: INV-llm-13`
- A translation with no languages listed is still a translation; `undefined`
  there would reach `renderTranslation` and print nothing where the source
  language belongs. `test: INV-llm-14`
- Backing off means waiting longer each time. A retry loop with a constant or
  shrinking delay adds load to a service already saying it has too much.
  `test: INV-llm-15`
- A language code with no name is shown as itself rather than dropped.
  `test: INV-llm-16`

## Calibration

`npm run calibrate -- --model <id>` scores the decision — never the translation
quality — against the answers a person wrote by hand in `fixtures/corpus`. It
exists to turn "the cheap model is enough" into a number, by running the same
corpus through a stronger model as the reference.

Disagreement is the finding, not a failure, so the run exits zero. A case that
could not be measured is recorded as such and never counted as agreement.
