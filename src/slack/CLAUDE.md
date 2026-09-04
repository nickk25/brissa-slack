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

## The field names stop here

`ephemeralFor` builds one reader's copy of a translation. It exists so that no
other module has to know our `threadId` is Slack's `thread_ts`: `receive`
performs that rename on the way in, and without this the rename on the way out
would live in the wiring — precisely the knowledge this boundary exists to
contain.

A top-level message gets **no** `thread_ts` key rather than one set to
`undefined`. Slack reads a present-but-empty `thread_ts` as a malformed request
instead of as a top-level post, and under `exactOptionalPropertyTypes` those are
genuinely different values.

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

## Invariants of addressing

- A translation is addressed to one channel and one reader. `test: INV-slack-16`
- Our thread becomes Slack's thread here and nowhere else; a top-level message
  carries no thread key at all. `test: INV-slack-17`
- The notification carries the translation, truncated — not the blocks, and not
  the untruncated text. `test: INV-slack-18`

## The security boundary

`verify.ts` is the only one in the product. The endpoint is a public URL anyone
can POST to, and everything downstream — the model call, the ephemeral, the
reader's channel — happens because something here said yes. A missing check does
not fail loudly: it works perfectly for Slack, and works just as well for
everybody else.

Slack signs `v0:{timestamp}:{body}` with the app's signing secret. Two
consequences are easy to get wrong and impossible to notice afterwards:

- The body must be the **raw bytes**, before any JSON parsing. Parsing and
  re-serialising changes whitespace and key order, and the signature then fails
  for reasons that look like a Slack outage.
- The comparison must be **timing-safe**. A byte-by-byte early exit leaks the
  expected signature to anyone patient enough to measure it, one byte at a time.

Age is the only thing that makes a captured request worthless, because a
signature never expires on its own. Five minutes, Slack's own recommendation:
long enough to survive a slow network, short enough that a replay is useless by
the time anyone finds it.

## The envelope, which `receive` never sees

`receive` is handed the inner event and knows nothing about delivery. The
envelope is where the two facts the edge needs live: the `event_id` that makes a
retry recognisable, and the challenge Slack sends once when the endpoint URL is
first saved. Failing that handshake means the app can never be installed at all.

## Invariants of verification

- A request Slack really signed is accepted. `test: INV-slack-19`
- Header casing is the proxy's business, not ours. A check that only works behind
  one deployment is a check that fails open behind another. `test: INV-slack-20`
- A signature made with another secret is refused. `test: INV-slack-21`
- A body altered after signing is refused — this is what a parse-and-reserialise
  would look like from here. `test: INV-slack-22`
- A request with no signature or no timestamp is refused by name.
  `test: INV-slack-23`
- A replayed request stops being valid, in both directions: a clock far ahead is
  not an early request but one whose age cannot be reasoned about. The boundary
  itself is inside. `test: INV-slack-24`
- A timestamp that is not a number is refused rather than compared. `Number('x')`
  is NaN and every comparison against NaN is false, so the age check would pass —
  the mutation that turns a guard into a hole. `test: INV-slack-25`
- A signature of the wrong length is refused, not thrown. `timingSafeEqual`
  throws on a length mismatch, and a crash where an attacker controls the input
  is its own problem. `test: INV-slack-26`
- The setup handshake is recognised and answered. `test: INV-slack-27`
- An event envelope yields the id a retry is recognised by. `test: INV-slack-28`
- A first delivery is retry zero rather than an absent one; NaN would compare
  false against every threshold. `test: INV-slack-29`
- An envelope we cannot use says which part was missing. Without an id a retry is
  indistinguishable from a new message, and the only safe reading of "we cannot
  tell" is to refuse rather than risk a second copy of a translation.
  `test: INV-slack-30`

