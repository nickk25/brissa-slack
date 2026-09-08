# Decisions

One entry per decision, in the shortest form that survives being read by someone
who was not there. This file exists so no agent re-litigates a question that has
already been settled — a decision not written here will be reopened.

## The model is Claude Sonnet 5

Measured, not assumed. Each of 28 real messages asked three times per model,
scoring only the **decision** — translate or stay silent — against answers a
person wrote by hand.

| Model | Right every time | Unstable |
| --- | --- | --- |
| Haiku 4.5 | 24/28 | 1 |
| **Sonnet 5** | **28/28** | 0 |
| Opus 5 | 28/28 | 0 |

Haiku is not merely four behind: it fails `c-013`, one of the three cases that
define the threshold between useful and noisy, and it answers `c-027` differently
on different runs. A model that gives two answers to the same message cannot be
reasoned about at all.

Sonnet and Opus are indistinguishable on this task, and Opus costs two and a half
times as much. Nothing measured here justifies the difference.

A correction worth recording, because it was nearly written down as fact: Opus
first appeared *unscoreable*, with `overloaded` errors on three consecutive runs.
That was the harness failing to retry a transient error, not the model failing.
Adding retries produced 28/28 immediately. A property of the measuring instrument
was about to become a recorded property of the thing measured.

**Revisit when** translation *quality* is measured. Everything above scores the
decision only, and the case for a stronger model rests entirely on quality — a
claim nothing here supports or refutes.

## Two ways the eval lied, and what closed each

**A single run is not a measurement.** The same prompt scored 26/28 and then
27/28 on consecutive runs. Differences being read as the effect of a change were
inside the noise. Every case is now asked three times and only cases answered
correctly *every* time count; a case that varies is reported as unstable rather
than as a pass or a failure.

**The prompt quoted the corpus.** Two of the three borderline cases were written
into the prompt as examples, one of them from its very first version. A case
whose answer is in the instructions measures nothing, and removing them dropped
Haiku from 26/28 to 24/28. `tools/eval/contamination.mjs` now fails the build if
a prompt quotes a case, and `coupling.yaml` runs it before any eval is accepted.

The corpus was already protected by a human label because whoever can edit the
expected answer can never be wrong. That guarded one side of the exam; this was
the other side, and it went unnoticed until somebody walked straight through it.

**Closed:** a held-out split now exists. 26 further cases, drawn from channels the
development set never touched, scored 26/26 with nothing unstable.

The rule attached to it matters more than the score: running it is fine, and
reading which of its cases failed in order to change the prompt spends it. Once
spent it becomes a second development set wearing the name of a reserve. If the
held-out score drops, the honest move is to look for the same weakness in the
development set.

It is weighted the other way on purpose — 16 `ignore` to 10 `translate`, against
5 to 23 in the development set. Restraint is the product and the development set
barely measured it. It also carries a direction the development set had none of:
**German embedded in English**, where the reader needs nothing and translating is
pure noise. That is the harder half of the problem and nothing measured it
before.

## Transient failures are retried

A `529` is the service saying "not now", not "no". Treating one as lost data cost
six of twenty-eight cases on a single run, and in production would cost a reader
their message — silently, which is the worst way to lose one. The eval retries
with backoff; the Slack adapter will have to do the same, and its failures have
to be visible rather than swallowed.

## Dependencies

Each one is surface no human will audit.

- **`yaml`** — the coupling manifest is read and written by agents, and YAML
  tolerates comments. That manifest is also the schema reference, and a reference
  with no room for explanation is a worse reference.
- **`@anthropic-ai/sdk`** — the official SDK, confined to `src/llm` by the
  dependency rules.
- **`typescript`** — types are the cheapest review a repository nobody reads can
  have. `tsc --noEmit` is the gate; the test runner strips types rather than
  compiling, so there is no build step to keep in sync.

## Mutation testing runs, and what it found the first time

`.github/workflows/mutation.yml` had been in this repository since the first
commit and had never once run: it calls `npm run mutate` and reads
`stryker.config.json`, and neither existed. The workflow came across from the
scaffolding; its configuration did not. So the control the root contract names as
the answer to "a test that exists but asserts nothing" was, for the whole life of
this repository, a file that would have failed on its first invocation.

**Stryker 10 cannot read a TypeScript 7 project.** Its sandbox rewrites
`tsconfig.json` through `ts.parseConfigFileTextToJson`, which the native
TypeScript 7 compiler no longer exports, and the run dies before mutating
anything. `tsconfigFile` is therefore pointed at `no-tsconfig-rewrite.json`, a
path that does not exist, which makes the preprocessor skip. That rewrite exists
to fix `extends` and `include` paths inside the sandbox, and nothing here needs
it: the test runner is `node --experimental-strip-types`, which never reads a
tsconfig. Revisit when Stryker supports TypeScript 7 — it is a workaround with a
real expiry, not a permanent arrangement.

The first honest measurement, and the second after acting on it:

| File | First run | After |
| --- | --- | --- |
| `src/llm/decide.ts` | **59.09** | **85.45** |
| `src/core/ask.ts` | 73.02 | 73.02 |
| `src/app/handle.ts` | 82.56 | 82.56 |
| `src/slack/receive.ts` | 85.19 | 85.19 |
| `src/core/render.ts` | 86.05 | 86.05 |
| `src/slack/send.ts` | 87.18 | 87.18 |
| `src/store/memory.ts` | 94.74 | 94.74 |
| **Total** | 76.57 | **83.57** |

`decide.ts` was the weakest file in the repository and it is the one where a
fault costs a reader their message. Forty-five mutants survived there, and nearly
all of them lived in the request: the fake model recorded only the system prompt,
so nothing had ever asserted the JSON schema, the model id, the token budget or
the user turn. Seven tests closed it.

The floor was raised by raising a score, never by lowering the bar — the
per-file ratchet in `tools/agentic/mutation-floor.mjs` stays empty, which is its
goal state. Pinning `decide.ts` at 59.09 would have been the other option, and it
would have recorded the weakest thing in the repository as acceptable.

## An ephemeral is not delivered, only accepted

`SendOutcome` said `delivered` for four days. Slack's own documentation says:

> "Ephemeral message delivery is not guaranteed — the user must be currently
> active in Slack and a member of the specified `channel`."

Not a member — **active**. A reader who belongs to the channel but does not
happen to be looking at Slack gets nothing, and the API answers `ok: true`. So
the single most common way this product fails a reader was being counted as a
success, by name, in the type system.

Renamed to `accepted`, which is all Slack reports. Nothing closes the gap itself;
what the code can do is refuse to claim more than it knows.

The same page carries the other half:

> "Make sure your app is a member of the conversation it's attempting to post a
> message to."

Membership is not an implementation choice, it is a requirement of the method —
which means the automatic path cannot exist without Brissa visibly joining a
channel. In a channel shared with a client, joining announces that you do not
understand them.

Together these two sentences reverse which half of the product is the important
one. The message-menu shortcut needs no membership, and the reader is by
definition looking at Slack at the moment they invoke it. It was on the list as
"covers what arrives while you are away". It is the half that works.

**Source:** `https://docs.slack.dev/reference/methods/chat.postEphemeral`

## The shortcut works where the bot cannot go

Two things the documentation never states outright, and both now measured rather
than argued:

**The message shortcut appears without the app being a member of the channel.**
**It works on a message written by somebody in the external organisation.**

Observed in the case that matters most: a private channel created by an
organisation outside this workspace, a message written by a member of that
organisation, Brissa not a member of the channel and never invited to it. The
shortcut appeared in the message menu, the translation came back, and Slack
labelled it "Only visible to you". Nobody on the other side saw anything —
neither a translation, nor a bot, nor the existence of the shortcut.

That settles the architecture. The automatic path requires membership, which
requires visibly joining a channel shared with a client, which announces that you
do not understand them. The shortcut requires nothing, and it is also the only
path whose delivery is reliable: `chat.postEphemeral` reaches a reader who is
"currently active", and somebody who just clicked is active by definition.

**What the shortcut costs** is a click per message. It is the right way round.
The automatic path remains useful in channels where being seen costs nothing —
internal ones — and is the wrong tool everywhere else.

**Revisit if** Slack changes shortcut visibility rules for externally shared
channels. Nothing in their documentation promises this behaviour, which is why it
is recorded here as observed rather than as read.

## The corpus has a case waiting

The same real message exposed a translation failure worth keeping. Five lines of
German, four translated, and the last one — `Sorry, aber wir sollten alle an
board haben` — returned untouched, in German, inside an otherwise Spanish
translation.

It is not in `fixtures/corpus/` yet because the corpus is protected: whoever can
edit the expected answer can never be wrong. It is named here so it is not lost
while it waits for a person to approve it.

## The quality layer exists now, and it is narrower than the name promises

`tools/eval/quality.mjs`. Built to close the gap the entry above describes: the
decision eval scored `c-001` a pass on the same run that returned its last line
untouched, in German, inside an otherwise Spanish translation, and nothing else
in this repository would have noticed either.

**What it measures:** for every corpus case whose expected decision is
`translate`, does each source line reappear — verbatim, or close enough that
nothing was done to it — in the translated output. Deterministic string
comparison finds the *candidates*; it is not, by itself, a verdict — see below
for what turns a candidate into a finding. Either way this is not a model
judging a model: a judge model answers "is this translation good" with the
same fluent confidence that produced the dropped line in the first place,
which makes it a check that can be charmed by the exact failure it exists to
catch.

**What it deliberately does NOT measure:** whether the translation reads
naturally, whether idiom or tone survived, whether a correctly *translated*
line is simply wrong, or the decision itself — that is still `calibrate.mjs`'s
job and this file skips any case that scored anything but `translate`. A
"clean" result here says only that nothing was left behind, not that what
arrived is good.

**A heuristic was tried first, and it made the tool worse than having none.**
The hard part is telling "left behind" from "correctly untouched": a reader
who reads English and Spanish will legitimately see an English line —
`c-001`'s own `Hi all.` — survive a translation unchanged, and a check that
only asks "does this source line appear in the output" would flag that
greeting exactly as loudly as the German line that actually failed. The first
version of this file tried to draw that line by counting closed-class function
words — articles, pronouns, conjunctions, a handful of greetings — and
exempting a line once half its tokens matched a language the reader reads.
`Hi all.` scored 100% and was correctly exempted. It did not generalise: real
sentences run roughly 40-50% function words, so any line with three or four
content words falls under a 50% bar regardless of what language it is in or
whether the reader can read it. `Perfecto, nos vemos el viernes.` (pure
Spanish, for a reader who reads Spanish) and `Can you review the deployment
pipeline configuration?` (pure English, same reader) were both flagged as
untranslated failures — ordinary sentences, correctly left alone, reported as
the exact bug this file exists to catch. A report that cries wolf on ordinary
input is a report nobody reads, the same argument
`tools/agentic/mutation-floor.mjs` makes about a threshold nobody meets. It was
deleted rather than tuned: no amount of adjusting the word lists or the
threshold fixes an instrument measuring the wrong thing.

**What replaced it: ask the translator about the surviving line, on its own.**
For every candidate line `findSurvivedLines` turns up, `probeSurvivedLine`
calls the same translator a second time, with just that line and the reader's
`reads`. `silent` means the model judges the line readable by this reader — it
was right to survive, not a failure. `translated` means the model judges it
NOT readable — it should have been translated the first time and was not, and
that is now attested by the same component this file already measured: 28/28
on the development corpus, 26/26 held out (see above). `failed` means the
probe itself broke, and is reported as its own bucket — never folded into
"clean" by default, and never treated as either a pass or a confirmed failure.
This is not a model grading a translation; it is the decision function this
repository already trusts, applied a second time to a shorter piece of text.

**The honest caveat that comes with it.** The 28/28 and 26/26 scores were
earned on whole messages, with whatever context they carried. A probed line is
asked about alone, stripped of its neighbours, so its accuracy here is
assumed, not measured — and a line whose meaning depends on the sentences
around it is exactly where this will be weakest. Nothing yet checks that
assumption.

**Cost, stated plainly.** This is one additional model call per line that
survived the first pass, not per source line — `findSurvivedLines` already
narrows the field, and `hasNothingToRead` narrows it again before that. It is
still a second real request per surviving line, which is the honest reason
this stays a nightly, by-hand, non-blocking run rather than something wired
into every pull request.

**Never run against a real model.** Every test in `quality.test.mjs` uses a
fake translator and a stand-in for `hasNothingToRead` — no network, no API
key. The tool imports the real `createTranslator` (`src/llm/decide.ts`) and the
real `hasNothingToRead` (`src/core/ask.ts`) dynamically, reached only from
`main()`, which nothing in this repository's test suite ever calls. What that
means honestly: the line-survival and probe-classification logic are both
exercised with fakes, the wiring to the real translator and the real corpus is
not, and neither is whether a probed line's answer, out of context, agrees
with what a human would say. The first real run is still owed.

**Revisit when** it has run against a real model at least once, and again if a
probed line's missing context turns out to change its answer often enough to
matter — the corpus does not yet have a case built to check that.

