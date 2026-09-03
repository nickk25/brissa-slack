# Brissa

Slack without the language barrier.

Brissa translates the messages you cannot read — privately, in place, and only
when there is something you could not have read yourself.

## What it does

You declare which languages you read. Brissa says nothing about anything else.
When a message contains a sentence outside them, the translation appears below
it, visible to you alone. Nobody else in the channel sees anything, and nobody
else has to install anything.

## Two decisions the rest follows from

**Detect by sentence, translate the whole message.** Real Slack messages are not
written in one language. A message that opens `Hi all.` and continues for four
paragraphs in German defeats any detector that reads a message as a unit — and
translating only the foreign fragments hands you a pile of sentences to reassemble
in your head, which is the work being removed.

**Silence is the feature.** If everyone in a channel shares a language, Brissa
does not exist. And the messages you cannot read are not a random sample: people
write in a second language until something matters, then revert to their own. The
untranslated messages are disproportionately the ones that change plans.

## What it does not do

Show every person the whole channel in their own language. Slack has one message
object per message, the same for everyone; there is no per-viewer rendering, and
any product claiming otherwise is duplicating the channel or writing into a
parallel one. Brissa does neither.

## How it is built

Written and maintained by agents, on the scaffolding in
[agentic-base](https://github.com/nickk25/agentic-base): coupling rules,
contracts regenerated from and compared against the code, invariants anchored to
tests that ran, and a measured state page. `main` is protected with an empty
bypass list.

The corpus in `fixtures/corpus/` is real, anonymised Slack traffic and the
decision each message should produce. It is what "correct" means here, and it is
protected — an agent that can edit the expected answer can never be wrong.

## Licence

AGPL-3.0. Running a modified Brissa as a service means publishing your changes.
For a commercial licence, ask.
