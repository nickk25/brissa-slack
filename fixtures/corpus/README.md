# Corpus

Real Slack messages, anonymised, and the decision each one should produce.

**This is the definition of "correct".** Whoever can edit it can never be wrong,
which is why `coupling.yaml` holds it behind a human label: an agent that can
change the expected answer can make its own output right by changing what right
means.

## What is preserved and what is replaced

Anonymised: people, companies, clients, products, projects, emails, domains,
URLs, Slack ids, handles and dates. Any message about health data, patients or
money was discarded whole rather than anonymised.

Preserved exactly, because it is the entire value of the corpus: the mix of
languages word by word, the typos, the missing umlauts, capitalisation,
punctuation, emoji, line breaks, length and structure.

The corpus has to be **real in its language, not in its facts.**

## Two sets, and what spends the second one

`messages.json` is the development set. A prompt may be tuned against it: read
which cases fail, change the wording, measure again.

`held-out.json` is not. Running it is fine — that is what it is for. **Reading
which of its cases failed and changing the prompt because of it spends it**, and
once spent it cannot be un-spent; it becomes a second development set wearing the
name of a reserve.

The rule is uncomfortable on purpose. Tuning a prompt by looking at what fails is
tuning to the evaluation set even when nothing is quoted, and the only defence is
a set whose failures you decline to look at. If the held-out score drops, the
honest response is to look at the *development* set for the same weakness, not to
open the reserve.

The held-out set deliberately carries more `ignore` cases than `translate` ones:
16 to 10, against 5 to 23 in the development set. Restraint is the product and
the development set barely measured it. It also carries a direction the
development set has none of — **German embedded in English**, where the reader
needs nothing and translating is pure noise. That is the harder half of the
problem and it was invisible before.

## Two layers, and only one of them blocks

| Layer | Measures | When |
| --- | --- | --- |
| Decision | Is there a sentence the reader cannot read? Deterministic, answers written by hand. | Every pull request. Blocks. |
| Quality | How good the translation is. Scored against a threshold. Not deterministic. | Nightly. Reports. |

A snapshot of a model's output is not a test. The first time it fails, the
cheapest response is to re-record it, and the corpus then means "whatever the
code produces today".

## `expected` assumes a reader of Spanish and English

`translate` when the message contains any sentence outside those two languages;
`ignore` otherwise. Change the reader and the expected answers change with them —
that is the point, and it is why the field is named for a decision rather than a
truth.
