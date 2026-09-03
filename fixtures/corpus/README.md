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
