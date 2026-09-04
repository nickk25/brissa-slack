# src/slack — contract

The only module that may know what a Slack event looks like.

## Purpose

Turn Slack's shape into ours, and ours back into Slack's. `receive` takes an
event payload and produces the four fields `src/core` can reason about.

## What it does not do

**Decide anything.** The temptation is to filter here, because the data is right
there — and that is exactly how an adapter fills with `if`s about message content
and quietly becomes the place the product lives. Whether a message is worth
translating is `src/core`'s judgement and stays there.

The one thing that looks like a decision and is not: rejecting events that are
not messages. An edit, a join, a topic change and a reaction all arrive on the
same channel, and none of them is a person saying something. Recognising Slack's
own event kinds is reading the payload, not judging its content.

## Why the boundary is worth its cost

Slack's payload is large, loosely typed, and changes on Slack's schedule.
`InboundMessage` is four fields. Everything that knows the difference lives here,
which is what keeps the logic testable with no network and no account.

The declared `SlackMessageEvent` names only the fields actually read. An event
carrying a hundred others is not a reason to accept a hundred others.

## Invariants

- An ordinary message becomes four fields the core can reason about. `test: INV-slack-01`
- A bot message is marked as one, which is what breaks the loop: Brissa's own
  translations arrive back through this same path. `test: INV-slack-02`
- A bot message with no `user` still has an author. An empty author would match
  nobody and therefore be treated as somebody, defeating the core's own-message
  rule. `test: INV-slack-03`
- An edit is not a new message; `message_changed` carries a differently shaped
  nested payload and reading it as a message would translate an edit nobody made.
  `test: INV-slack-04`
- A join, a leave or a topic change is not a message in the channel. `test: INV-slack-05`
- An event that is not a message is rejected by name. `test: INV-slack-06`
- An empty or whitespace-only message carries nothing to translate. `test: INV-slack-07`
- A thread reply keeps its thread and a top-level message has none — absent
  rather than undefined, so the two stay distinguishable. `test: INV-slack-08`
- Rejection always says which kind of event it was. Slack sends far more than
  messages down this channel and a silent drop is indistinguishable from a bug.
  `test: INV-slack-09`

## Sending, and the limit that shapes the product

Slack has exactly one way to show a message to a single person in a channel:
`chat.postEphemeral`. It carries a constraint worth stating plainly, because the
product is built around it rather than despite it:

**Slack only delivers an ephemeral message if the reader is currently in the
channel.** Someone opening Slack to forty overnight messages receives none of
them.

So `reader-not-in-channel` is an outcome, not a failure — the expected answer for
anything that arrived while nobody was looking. It is also why a private shortcut
on the message menu is not a nice-to-have: this path covers what arrives while
the reader is present, the shortcut covers the rest, and neither is sufficient
alone.

A real refusal — a missing scope, a bad token, malformed blocks — is a different
outcome with a different owner, and collapsing the two would hide a bug behind an
expected silence.

## Invariants of sending

- A delivered ephemeral says so. `test: INV-slack-10`
- A reader who was not in the channel is its own outcome, not a failure.
  `test: INV-slack-11`
- A real refusal is not mistaken for absence; only one of the two is somebody's
  job to fix. `test: INV-slack-12`
- A failure never reports as delivered. A translation that silently failed to
  appear is indistinguishable, to the reader, from one Brissa chose not to make.
  `test: INV-slack-13`
- The fallback text is one line and fits a notification; without it the push
  notification reads "This content can't be displayed". `test: INV-slack-14`
- A short translation is not truncated. `test: INV-slack-15`

## Still missing

The shortcut. And a real client: `SlackApi` is one method wide, which is all this
module needs and all its tests require, but nothing yet implements it.
