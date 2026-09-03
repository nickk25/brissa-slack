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

## Still missing

Sending. `receive` is half an adapter: the other half posts the translation as an
ephemeral message visible only to the reader, and has to survive Slack declining
to deliver one — which it does whenever the reader is not currently in the
channel.
