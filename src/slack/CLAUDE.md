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

Two limitations, both quoted from Slack rather than inferred.

> "Ephemeral message delivery is not guaranteed — the user must be currently
> active in Slack and a member of the specified `channel`."

Not merely a member: **active**. Someone opening Slack to forty overnight
messages receives none of them, and Slack answers `ok: true` for every one.

> "Make sure your app is a member of the conversation it's attempting to post a
> message to."

So this path cannot exist without Brissa visibly joining the channel — which in
a channel shared with a client announces that you do not understand them.

**Nothing here returns `delivered`, and that is the correction.** The outcome is
`accepted`: Slack took the message. Whether anybody saw it, Slack does not
report, and this module used to call that success. Naming the most common
failure in the product after a success is how it stayed invisible.

`reader-not-in-channel` remains a distinct outcome rather than a failure — the
expected answer for a reader who is not a member. Between the two quotations
above, the message-menu shortcut is not a nice-to-have but the better half of the
product: it needs no membership, and the reader is by definition looking at Slack
at the moment they ask.

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

- An accepted ephemeral says only that it was accepted. `test: INV-slack-10`
- A reader who was not in the channel is its own outcome, not a failure.
  `test: INV-slack-11`
- A real refusal is not mistaken for absence; only one of the two is somebody's
  job to fix. `test: INV-slack-12`
- A failure never reports as accepted. A translation that silently failed to
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
- Valid JSON that is not an object is refused rather than read. `JSON.parse`
  succeeds on `null` and on every scalar, and reading a field off one throws —
  which at the edge escapes as a rejected promise instead of a response.
  `test: INV-slack-31`
- Something Slack sends that this app does not handle is **named, not condemned**.
  `app_rate_limited` is legitimate and signed; calling it unusable would make the
  edge answer with an error, and a run of those is what makes Slack disable an
  app's event subscriptions altogether. `test: INV-slack-32`

## The real client, which is one HTTP call

`web.ts` answers `SlackApi` with `fetch`. No SDK: the interface is one method
wide and `chat.postEphemeral` is a POST with a bearer token and a JSON body, so a
dependency here would be a package tree, a release cadence and a changelog to
follow in order to avoid writing twelve lines.

It must never throw. Slack answers **200 with `ok: false`** for application
errors and a non-2xx for the ones that never reached the application, and a
dropped socket is neither — all three have to arrive in the same shape, because
`sendEphemeral` above turns that shape into outcomes and an exception would land
somewhere with no vocabulary for it.

- The call carries the token and the request as Slack expects them.
  `test: INV-slack-33`
- Slack refusing with a 200 is still a refusal; reading only the status code
  would count every one of those as a delivered translation. `test: INV-slack-34`
- A failure that never reached the application still has a name.
  `test: INV-slack-35`
- A dropped connection is reported, never thrown. `test: INV-slack-36`

## Socket Mode, and the check that is deliberately absent

`socket.ts` is Slack's other way of delivering the same envelopes: the machine
running Brissa opens a websocket **outward**, and Slack pushes events down it. No
public URL, no tunnel, no deployment — the only reason any of this can be run
before any of it has been deployed.

The security model differs, and it looks like something is missing. Over HTTP
Slack signs every request and `verify.ts` proves it. Over a websocket **the
connection is the proof**: it was opened with an app-level token against a URL
Slack issued for this app alone. There is no signature on these frames and none
is expected.

What does not change is the acknowledgement. Slack redelivers an envelope it has
not heard back about within three seconds, exactly as over HTTP — so the ack goes
out before the work starts, and `Seen` catches whatever slips through. The two
paths share `acceptEnvelope` for precisely this reason; written twice, they would
drift.

Reconnecting is the normal case rather than the error case: Slack sends
`disconnect` before its own deploys. The backoff exists for the abnormal one, so
a revoked app token does not reconnect in a tight loop forever.

- An event frame yields the id to acknowledge and the envelope inside it.
  `test: INV-slack-37`
- `hello` and `disconnect` are recognised, and neither is an error.
  `test: INV-slack-38`
- A frame this app has no use for is named rather than mistaken for one. That
  includes whatever Slack adds next, and an `events_api` frame with no envelope
  id — which cannot be acknowledged, so acting on it would guarantee the
  redelivery it was meant to prevent. `test: INV-slack-39`
- The envelope is acknowledged before it is handed on. `test: INV-slack-40`
- A frame with nothing to act on is acknowledged to nobody; acknowledging one we
  did not understand would tell Slack it was handled. `test: INV-slack-41`
- A closed connection is reopened, because Slack closes them routinely — it sends
  `disconnect` before its own deploys, and treating that as a failure would mean
  Brissa stops working every time Slack ships. `test: INV-slack-42`
- Closing on purpose stays closed. The difference between "Slack dropped us" and
  "we are shutting down"; a reconnect loop ignoring the second keeps a process
  alive forever. `test: INV-slack-43`
- A connection Slack refuses to open is said out loud and tried again. A revoked
  app token fails there every time, and silence would leave a process that looks
  alive and receives nothing. `test: INV-slack-44`
- Arriving connected resets the backoff, so a connection that survives an hour
  and then drops does not wait thirty seconds it earned days earlier.
  `test: INV-slack-45`
- A connection waiting to reopen keeps the process alive. The opposite shipped:
  the reconnect timer was `unref`ed, so when the socket closed — which Slack does
  routinely — the only pending work was a timer Node had been told to ignore, and
  the process exited with status 0. Brissa was off and it looked like a clean
  shutdown. Asserted by running it in a child process, because a unit test cannot
  see whether the event loop is held open. `test: INV-slack-70`

## The shortcut, and why it is the better half

`chat.postEphemeral` requires the app to be a member of the channel, and only
reaches a reader who is currently active. Both are quoted above. The message-menu
shortcut has neither constraint, and gets there by a different door:

> "The `response_url` will bypass any channel posting permissions when used as a
> part of an app's action."

> "By default, a message published via `response_url` will be sent as an
> ephemeral message."

No membership, so no join message and nothing in the member list. In a Slack
Connect channel the other organisation cannot even see the shortcut exists —
"message actions are not shared; they are limited only to the team that has
installed the app". And the reader is by definition looking at Slack at the
moment they ask, which is the delivery condition the automatic path can only hope
for.

The cost is a click per message. That is the trade, and it is the right way
round.

`response_type` is never sent. Ephemeral is the documented default; naming it
invites somebody to change it to `in_channel` one day and publish a colleague's
translation to the room.

- A shortcut says who asked, whose message it was, and where to answer.
  `test: INV-slack-46`
- Asking about your own message is allowed here. On the automatic path that is
  `own-message` and it is skipped; refusing a request because nobody requested it
  makes no sense. `test: INV-slack-47`
- A bot's message still has an author when somebody asks to read it.
  `test: INV-slack-48`
- A shortcut with nowhere to answer is refused. Answering is the entire
  interaction. `test: INV-slack-49`
- Anything that is not a message shortcut is refused by name. `test: INV-slack-50`
- A thread reply keeps its thread; a top-level message carries none.
  `test: INV-slack-51`
- The private answer never names its own response type. `test: INV-slack-52`
- An answer that never arrived is reported, not thrown. `test: INV-slack-53`
- The response budget is the one Slack documents — five answers within thirty
  minutes — written down because the number decides whether a retry is possible
  at all and nothing else in the code says it. `test: INV-slack-54`
- An interaction is acknowledged and handed on unparsed: this module knows the
  frame, `shortcut.ts` knows what is inside it. `test: INV-slack-55`

## The slash command, and the other credential

`/translate` reads recent messages instead of one Slack already handed it, and
that read cannot go through the bot token. `conversations.history` with a bot
token answers `channel_not_found` unless the app is a member of the channel,
and joining one is exactly as visible as it is for the automatic path — visible
to everyone in it, including, in a Slack Connect channel, the organisation on
the other side. So `history.ts` reads with a **user token**: Brissa reads as
whoever typed the command, in channels they already belong to, and joins
nothing. `docs/DECISIONS.md` records the same reasoning for the shortcut's own
door into this problem; this is the read-side half of it.

Four things about that token are structural rather than a habit this module
has to keep:

- It is asked for only in response to a command. Nothing here polls, syncs, or
  reads a channel ahead of somebody typing `/translate` — there is no second
  caller of `history.ts` anywhere in this codebase.
- Nothing it reads is persisted. A message reaches the model that translates it
  and the screen of whoever asked; there is no store, no cache, no file and no
  log line carrying its text.
- It is read-only in this code path. `History` declares one method and this
  file implements only that one; posting a translation back happens through
  `response_url`, a different credential entirely, held by `shortcut.ts`.
- `manifest.json` requests only history scopes for it — `channels:history`,
  `groups:history`, `im:history`, `mpim:history` — never `search:read`,
  `files:read` or a profile scope it has no use for.

`command.ts` is the other half: turning the slash command payload Slack sends
into our own shape, and turning its one free-text argument into exactly one of
three things — nothing (the most recent message that is not the caller's own),
a small integer (a count), or literal text. The count is bounded; the stated
maximum and why it is that number rather than Slack's own page size live next
to the constant in `command.ts` itself.

- An ordinary read returns messages newest first, each with an author and text,
  and nothing that is not a person saying something — mirroring `receive.ts`'s
  own list of what a join, a leave or a topic change is instead.
  `test: INV-slack-56`
- A message with no `user` still has an author, the same fallback the shortcut
  and the events adapter both use. `test: INV-slack-57`
- Slack refusing with a 200 is reported as data. `test: INV-slack-58`
- A bad status and a dropped connection are both reported, never thrown.
  `test: INV-slack-59`
- The call reads with the user token and never posts anything — a GET, no
  body, `conversations.history` and nothing else. `test: INV-slack-60`
- Only history scopes are requested, for the user token in `manifest.json` —
  no search, no files, no profile reads. `test: INV-slack-61`
- A slash command payload becomes the fields the app needs, and empty text
  defaults to the latest message rather than an error. `test: INV-slack-62`
- A small integer becomes a count. `test: INV-slack-63`
- Anything else is literal text, verbatim — `/translate 5 people showed up` is
  a sentence that happens to start with a digit, not a count of five.
  `test: INV-slack-64`
- A count of zero, or larger than the stated maximum, is refused by name.
  `test: INV-slack-65`
- A malformed payload, or one with nowhere to answer, is refused by name — and
  every refusal that *has* somewhere to answer carries it, because Slack
  acknowledges a command before any of this runs and a refusal the caller cannot
  hear is a command that silently did nothing.
  `test: INV-slack-66`
- A slash command is acknowledged and handed on unparsed, same discipline as an
  interaction. `test: INV-slack-67`
- Whose account a token belongs to is asked, not assumed. A credential nobody
  checked the owner of is one nobody can be told about, so an unanswerable check
  comes back undefined rather than as an optimistic guess. `test: INV-slack-68`
- A count means messages a person wrote, not entries Slack returned. Slack's own
  `limit` counts raw entries and joins and topic changes are filtered out after,
  so asking for exactly five would quietly translate two. `test: INV-slack-69`

## `/brissa`, the door that used to be a laptop

Every reader used to be a line in `BRISSA_READERS` — an environment variable on
somebody's machine. Enrolling a new person meant editing that file and
restarting the process, which does not scale past one, and was the whole reason
nobody else on the team could use Brissa. `enrol.ts` is `command.ts` again, same
shape, same discipline: Slack hands this a flat, form-encoded payload and this
file's only job is turning it into `EnrolCommand`, never deciding what to do
with one.

`text` stands for the same three-way split `/translate`'s argument does, one
size smaller: nothing (query), the word `off`, or one or more language codes. A
code's region is folded away — `es-ES` becomes `es` — because `render.ts` names
a language from a bare two-letter code and nothing else; keeping the region
would silently turn a language Brissa already knows how to name into one it
does not. What is checked is the *shape* every ISO 639-1 code has, two letters,
never a fixed list of the languages Brissa happens to name today — a code this
file has never heard of is still a real language, and refusing it here would
refuse translations that would otherwise work fine.

A single bad token refuses the whole line, not just itself. `/brissa es xx fr`
partially applied would leave the caller unsure which of the three actually
took, and `off` typed alongside real language codes is refused the same way,
by the same check — it is not a two-letter code either, so it is not one of two
special forms silently guessed at.

- No argument, empty or blank, reads as a request to see what Brissa currently
  thinks — the query form, not a refusal. `test: INV-slack-71`
- Language codes are read in the order given — the first is the one a
  translation would be made into. `test: INV-slack-72`
- Case and region are folded sensibly: `ES`, `es-ES` and `es` all mean the same
  language. `test: INV-slack-73`
- A token that is not a real language code is refused, whether it stands alone
  or sits beside real ones — including `off` used as if it were one.
  `test: INV-slack-74`
- `off`, in any case, alone, reads as a request to stop. `test: INV-slack-75`
- A payload with nowhere to answer is refused before anything else is read.
  `test: INV-slack-76`
- A payload with no team is refused, carrying the response_url the payload
  gave. `test: INV-slack-77`
- A payload with no user is refused, carrying the response_url the payload
  gave. `test: INV-slack-78`
- Something not shaped like a command payload at all — `null`, an array, a
  scalar — is refused by name. `test: INV-slack-79`

## `oauth.ts`, and why the owner stopped being the only reader

The user token above belongs to whoever ran `/translate` first, and until now
Brissa held exactly one of them. `command.ts` refuses everybody else by name
rather than reading under that one person's identity, for the reason stated
there: it would put a colleague's request under the owner's name in Slack's
own access log and let the owner's channel memberships decide what a stranger
to this file gets to see. `oauth.ts` is how each person gets their own token
instead — the Slack-facing half of an OAuth flow; nothing here decides who is
allowed to run it or where a token ends up stored, only the redirect, the
signed `state` that survives the round trip, and the exchange.

**User scope only, and there is no field for a bot scope to leak into.** The
bot is already installed by the time anyone runs this flow; `authorizeUrl`
builds `user_scope` from exactly the four history scopes `manifest.json`
already declares and never builds a `scope` parameter at all. Asking for a
bot scope here would silently make Slack revisit permissions this flow has no
business touching.

**`state` is signed, not stored — and a signature proves less than it looks
like it does.** Slack's own purpose for `state` is to stop somebody being
walked through an authorisation they never started; a consent-screen link
with no `state` at all lets an attacker send a victim their own link and
receive the victim's token back. `signState`/`readState` follow `verify.ts`
closely — the same HMAC discipline, the same timing-safe comparison, the same
guard against `timingSafeEqual` throwing on a length mismatch instead of
refusing. **Deliberately stateless**: the payload and its expiry travel
inside the signed value itself rather than in a server-side session keyed by
an id in it, because this process can restart between the redirect out to
Slack and the redirect back — a deploy, a crash, an ordinary restart — and a
person mid-flow must not be stranded holding a `state` that now points at a
session nobody remembers.

But `readState` returning `ok: true` proves only that *this app* minted the
value, unaltered, inside its window — it proves nothing about whose flow it
was. An attacker can start this flow honestly, receive a validly signed
`state` carrying their own Slack identity, and hand that value — not their
own login, just a query parameter — to a victim as if it were a link to
click. If the victim consents on Slack's real page, Slack redirects back with
the victim's own `code` next to the attacker's `state`; a caller that trusted
the signature alone would store the victim's token under the attacker's
identity. `sameAccount` closes that gap by comparing the account `signState`
was given against the account `exchangeCode` actually returns — whatever
wires this flow together **must** call it before writing to
`src/core/tokens.ts`, and must key that write by `exchangeCode`'s answer,
never by the state's own claim about who it was for. `state` is carried as an
`OAuthState` — `{ teamId, userId }`, the same pair every other port in this
product keys by — specifically so this comparison always has something to
compare.

A signed `state` is not single-use on its own — nothing here keeps a seen set
of them the way `src/core/seen.ts` does for event deliveries. It does not
need to: the value that is genuinely one-time is Slack's own authorization
`code`, which Slack itself refuses on a second exchange. Once `sameAccount` is
enforced, pairing a captured `state` with anyone else's `code` gains an
attacker nothing to begin with.

Ten minutes, not `verify.ts`'s five: that five-minute window bounds a
server-to-server request measured in milliseconds, so it is already generous
for its job. This one bounds a *human* round trip through Slack's own
consent screen — for a workspace with SSO, through an identity provider
Brissa does not control — and five minutes is tight enough that an
interruption mid-approval would force a person to start over. Ten minutes
gives that room without leaving a captured `state` useful for long.
`readState` also refuses a validly-signed value whose embedded expiry claims
a lifetime longer than this window: only the secret's holder could produce
one, so it is defence in depth rather than a live forgery path, but a value
`signState` could not have produced a moment ago is a truer "malformed" than
a quiet accept.

**`exchangeCode` reads `authed_user.access_token`, never the top-level
`access_token`.** Slack's response to `oauth.v2.access` carries two tokens
when bot and user scopes are both in play: the top-level one is the bot's,
`authed_user.access_token` is the person's. This flow requests only a user
scope, but Slack's response shape does not change to match — the field is
still nested under `authed_user`, and reading the wrong one stores a
credential that is not this person's at all, in the way that is hardest to
notice: a real, valid Slack token, just not the one anybody meant to hand
over.

It must never throw, for the same reason `web.ts` and `history.ts` state for
themselves: Slack answers `200` with `ok: false` for an application error and
a non-2xx for one that never reached the application, and a caller several
`await`s downstream has no shape for an exception, only for data. A claimed
success is trusted no further than a network response deserves either: every
field of `team`, `authed_user` — the fields `response.json()` is cast to a
shape of, the same pattern `web.ts` and `history.ts` already use — is checked
to be a real, non-empty string before this function calls it complete, not
merely present. `null`, a number, or an empty string would all satisfy a
bare `!== undefined` check and none of them is a usable token.

**The secret and the code never reach a returned `detail`.** This function
holds two things at once no other adapter in this product does — a Slack
credential and Brissa's own app secret — and a failure path that echoes
either back out, even by accident through a caught error's own message, is a
worse bug than the failure it was reporting. The transport-failure branch
classifies the failure into one of a fixed, closed set of words — never by
reading `err.message`, and not by reading `err.name` either: both are just
strings whatever threw got to write, and a hand-rolled `Error` subclass, or a
library that logs its own request on failure, could put anything in either
one. Reading neither is the only version of "never leaks" this function can
actually promise for a value it did not create.

- `authorizeUrl` requests only the four history user scopes, and no bot
  scope at all — there is no parameter for one to leak into.
  `test: INV-slack-80`
- The requested user scopes are the same list `manifest.json` declares under
  `oauth_config.scopes.user`. `test: INV-slack-81`
- A state signed and read back before it expires returns the same payload.
  `test: INV-slack-82`
- A state past its expiry is refused, and the boundary itself — read exactly
  at the window — still verifies. `test: INV-slack-83`
- A state signed with a different secret is refused. `test: INV-slack-84`
- A state altered after signing is refused — what a parse-and-reserialise, or
  a tampered query parameter, would look like from here. `test: INV-slack-85`
- A state with no signature separator is refused rather than thrown.
  `test: INV-slack-86`
- A signature of the wrong length is refused, not thrown — the same guard
  `verify.ts` states for Slack's own request signatures.
  `test: INV-slack-87`
- A validly-signed body that is not our own shape underneath is refused as
  malformed rather than accepted — including one carrying an unexpected
  `__proto__` key, refused by the same exact-shape check as any other wrong
  shape rather than by a dedicated guard. A signature only proves the bytes
  were not altered after signing, never that they were ever one of ours to
  begin with. `test: INV-slack-88`
- A state claiming a longer lifetime than `signState` ever grants is
  refused, even though correctly signed — a value this module could not have
  produced a moment ago. `test: INV-slack-89`
- `sameAccount` matches only when both the team and the user agree; either
  one differing is a different account, not a partial match.
  `test: INV-slack-90`
- `exchangeCode` reads the `authed_user` token, never the top-level bot
  token. `test: INV-slack-91`
- Slack refusing with a 200 is treated as a refusal, not a success.
  `test: INV-slack-92`
- A bad status and a dropped connection are both reported, never thrown.
  `test: INV-slack-93`
- A success response is refused by name unless every one of its fields is a
  real, non-empty string — missing, empty, `null` and wrongly-typed all
  count as incomplete. `test: INV-slack-94`
- An error response whose own `error` field is not a real string reports a
  fixed placeholder instead of passing the untrusted value through.
  `test: INV-slack-95`
- A transport failure is classified from a fixed vocabulary, never by
  echoing the thrown value's own message or name. `test: INV-slack-96`

