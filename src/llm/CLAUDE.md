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

  Restraint has a boundary, and it cost a real reader to find it. The courtesy
  exception once read "a short, universally understood courtesy — a greeting, a
  thank-you, an acknowledgement", illustrated by `Grazie!` — one word — while
  the bullet under it said the test is not length. Given that contradiction and
  a standing instruction to stay silent when in doubt, the model read "Hey and
  happy Monday, thank you for the Update" as a courtesy and said nothing, to
  somebody who reads only Spanish. Correct by the prompt as written, and useless
  to the person it was written for. The exception is now bounded to an isolated
  token, with the sentence named as what it does not cover: warmth and ordinariness
  are not what makes a message skippable, being one word is.
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

An evaluation scores the decision — never the translation quality — against
the answers a person wrote by hand in `fixtures/corpus`. Disagreement is the
finding, not a failure, so a run exits zero. A case that could not be measured
is recorded as such and never counted as agreement.

### API spend is real usage, and nothing else

That is the rule, decided after a month in which roughly all of the $7.02 spent
on the Anthropic key was testing and none of it was the product serving anybody.
It is stricter than it needs to be for correctness, and deliberately so: a rule
with a cost-benefit exception in it is a rule somebody argues past one run at a
time.

So evaluations run through **agents on the same model**, which cost nothing
beyond the subscription already paid for:

```
npm run eval:agent-job -- --corpus messages      # the cases, stripped of every hint
# three agents answer it, each into its own file
npm run eval:agent-record -- --job <job> run1.json run2.json run3.json
```

That satisfies `prompt-evaluated`, on every prompt change and every deploy, for
free. `calibrate`, `eval:quality` and `smoke` still exist, and refuse to run
without `--spend` (`tools/spend-guard.mjs`), so nobody — a person or an agent —
spends by habit.

**What the agent route does not measure**, stated because a number that
over-claims is worse than no number. It is the same model answering the same
prompt; it is not the same call. In production `decide.md` *is* the system
prompt and the output is held to a schema by constrained decoding. An agent
reads the prompt as content, writes its JSON by hand, and carries its own
instructions and tools. For "does this translate or stay silent" the difference
is small; at a boundary it may not be. That is why every recorded score carries
`method`, and why `eval:check` prints it next to the number.

### When a paid run is worth recommending

Never automatically — not per edit, not per deploy, not for thoroughness. A paid
run is recommended to Nick, with the reason and the rough cost, and happens only
if he agrees. There are four reasons that justify recommending one:

1. **The shape of the call changed, not the prompt.** The `output_config` schema,
   `max_tokens`, the model string, how the system prompt is assembled in
   `decide.ts`. This is the treacherous one: behaviour changes with no prompt
   touched, so `prompt-evaluated` never fires, and it is precisely the thing an
   agent cannot reproduce, because it does not decode against a schema.
2. **An agent evaluation moved a boundary case.** A case that flipped between
   translate and ignore compared with the previous record is where the two
   routes are most likely to disagree. If nothing moved, nothing is owed.
3. **Reality contradicted the evaluation.** Somebody reports a silence or a bad
   translation on a case the agents scored as fine. That is evidence the free
   route has drifted from the real one.
4. **The model that ships is changing.** A new model, or pressure on cost.
   Comparing models is the one question agents cannot answer at all.

When one is approved, run the smallest thing that answers it: the model that
ships, the corpus the question is about, `--runs` as low as the question allows.

### Invariants

- An agent is given the prompt and the words of each case, and nothing that gives
  the answer away. Every other field on a corpus case is a spoiler.
  `test: INV-llm-17`
- A case a run did not answer, or answered with something that is not a boolean,
  is never counted as agreement — and is reported once, not twice.
  `test: INV-llm-18`
- The agent route and the API route score identically, through one function, so
  the only thing that can differ between two reports is `method`.
  `test: INV-llm-19`
- Nothing that spends API money runs without being told to.
  `test: INV-llm-20`

The habit behind all of this was learned the expensive way: several throwaway
probes went through the API before anybody asked why, and four model
configurations were calibrated when the gate asked for one. Before editing a
prompt at all, check whether the behaviour can be had without one — `/say`
reuses `decide.md` with `reads: [target]` and cost nothing to build.
