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
