# src/app — contract

The one place every piece meets, and the only module allowed to import them all.

## Purpose

Take a Slack event and carry it to whatever each reader ends up seeing:
`receive` → `lookup` → `shouldAsk` → `translate` → `renderTranslation` →
`sendEphemeral`. That is the whole module. It puts existing pieces in an order
and awaits them.

## What it does not do

**Decide anything, and know no format.** Every judgement belongs to `src/core`
and every payload shape belongs to an adapter — which is why this module asks
`src/slack` for `ephemeralFor` rather than assembling a `chat.postEphemeral`
payload itself. It named `thread_ts` here once; that was a Slack field name
living in the wiring, and it is the shape of every future leak. This module is also where that
stops being enforceable by inspection, because it is the first one permitted to
import from everywhere.

The check is narrow enough to apply without thinking: **if this file ever
contains an `if` about the *content* of a message, the rule it encodes was moved
out of `src/core` and out of reach of the corpus.** The policy check is the
tempting one — an early `if (!policy.enabled) return` here would read as an
optimisation and would in fact duplicate `ask.ts` in the wiring. `shouldAsk`
decides, per reader, and the resulting count of skips is the honest number of
reader–message pairs.

## Grouping, and why the key is ordered

`TranslationRequest` is `{ text, reads }` and carries no reader identity, so two
readers with the same `reads` produce a byte-identical request. One call serves
both. Asking twice pays twice and, worse, can return two different answers for
one message — a difference between two colleagues that no counter could explain.

The key is the **ordered** tuple, not the set: `src/llm/decide.ts` translates
into `reads[0]`, so `['es','en']` and `['en','es']` are different translations
and must not share a call.

Grouping happens strictly **after** `shouldAsk`. Before it, the author of the
message would land in a group with his own recipients, and a reader who has
declared no languages would form a group whose request the translator can only
fail — turning a skip that has a reason into a failure that has a stack trace.

## The outcome has two levels

A flat list of per-reader outcomes makes an empty array mean four different
things: the event was not a message, the channel has nobody enrolled, the lookup
broke, or every reader was skipped. Those are the same silence with four
different owners.

`stage` on a failure is load-bearing rather than decorative: a translate failure
is `src/llm`'s to fix, a send failure is `src/slack`'s. Same word, two owners.

`sent` does not mean seen, and no outcome here claims otherwise. Slack accepts an
ephemeral for a reader who is not looking and reports success; the quotation is
in `src/slack/CLAUDE.md`. This module names what is known.

## Two guarantees, and one deliberate non-guarantee

**This never rejects.** Every port call is wrapped, and so is everything between
them: `renderTranslation` runs after one await and before the next, is not a
port, and would otherwise escape as a rejected promise if handed a malformed
`Translation`. The caller is an HTTP handler that has to answer Slack within
seconds whatever happened, and a thrown error there becomes a Slack retry —
which becomes a second copy of every ephemeral, precisely when something is
already wrong.

**The order of outcomes is the order the directory gave.** An order that depended
on which model call returned first would make every assertion about this flaky.

**Deduplication is not this function's job**, and cannot be: Slack's retry count
and event id live in the envelope, which `receive` never sees. It belongs to
whatever answers Slack's request. Called twice with the same event, this honestly
does the work twice, and `INV-app-18` asserts that rather than leaving the
absence to be read later as a bug.

## Invariants

- One message reaches every reader who needed it and nobody else, with the blocks
  `renderTranslation` produced — including the anchor, which needs the author and
  the original text this module is already holding. `test: INV-app-01`
- Readers who read the same languages cost one model call, not one each.
  `test: INV-app-02`
- The same languages in a different order are a different translation, because
  the first is the one translated into. `test: INV-app-03`
- Silence is an answer with a shape rather than an empty list. Restraint is the
  product, so "nothing was sent" must stay distinguishable from "nothing was
  considered". `test: INV-app-04`
- A translation failure is visible, attributed to a stage, and confined to its
  own group. `test: INV-app-05`
- A port that throws becomes an outcome, never a rejected promise.
  `test: INV-app-06`
- A reader who was not in the channel is not a failure, and a refusal is not an
  absence. One is expected; the other is somebody's job. `test: INV-app-07`

- A send that throws is the sending module's failure, not the model's.
  `test: INV-app-08`
- A disabled channel spends nothing at all — no model call, no post — and says so
  once per reader. `test: INV-app-09`
- The author is never posted his own words back, even when he shares a reads
  tuple with real recipients and would therefore land in their group.
  `test: INV-app-10`
- A reader who has declared no languages never reaches the model. This is the
  invariant that pins grouping to *after* `shouldAsk`: such a reader would
  otherwise form a group whose request the translator can only fail.
  `test: INV-app-11`
- A bot message and a message with nothing to read both cost nothing.
  `test: INV-app-12`
- A channel Brissa knows nobody in says so rather than returning an empty list.
  `test: INV-app-13`
- An event that was never a message is rejected by name, before anything is
  looked up. `test: INV-app-14`
- A directory that breaks is reported as a broken directory, never as an empty
  workspace. `test: INV-app-15`
- A translation lands in the thread it belongs to, and a top-level one carries no
  thread at all — absent rather than undefined, which Slack treats as malformed.
  `test: INV-app-16`
- Escaping survives the seam between rendering and sending. `test: INV-app-17`
- The same event twice does the work twice, because deduplication belongs to the
  HTTP edge. `test: INV-app-18`
- The real adapters compose: a Slack event becomes an ephemeral with no fake
  between them but the two edges that would need a network. `test: INV-app-19`
- The reader gets the whole translation and the notification gets a glance of it.
  Two different budgets; one string serving both would either truncate what the
  reader reads or push a paragraph into a notification. `test: INV-app-20`
- Two groups that both need translating each get their own translation, in the
  channel the message arrived in. `test: INV-app-21`
- One reader's send failing does not take down the others in their group.
  `test: INV-app-22`
- Two readers are grouped only when they declared the very same thing. A key
  built by joining would make `['es en']` and `['es','en']` one group, and the
  loser of that collision would be sent a translation into a language they never
  declared — silently, and only for them. `test: INV-app-23`

## The edge

`http.ts` is the public surface: one HTTP request in, one answer out, and the
real work happening after the answer has already gone. Three things have to be
true before anything downstream runs, and each is here because it cannot be
anywhere else.

**Answer first, work after.** Slack expects a response within about three seconds
and redelivers the event if it does not get one. A model call with retries can
take longer than that on its own, so waiting for the translation before answering
would guarantee a duplicate exactly when everything is already slow. The response
is decided before `handleMessage` is awaited, and the work comes back as `done`
for the caller to keep alive.

**Prove it came from Slack.** This is the only place `verifySignature` is called,
and nothing reaches `handleMessage` that has not been through it.

**Recognise a redelivery.** `handleMessage` deliberately does not and cannot: the
retry count and event id live in the envelope, which `receive` never sees. This
is the only layer holding both.

It is transport-agnostic on purpose — no `node:http`, no framework, no server. A
request is a body and some headers; an answer is a status and a string. That is
what makes the entire edge testable without opening a port.

Two status codes are decisions rather than conventions, and they are opposites.

A delivery **missing a piece of itself** is answered **400**. A 200 would tell
Slack it was handled, and saying that about something we could not parse absorbs
a real fault into silence.

Something Slack sends that this app simply **does not handle** — `app_rate_limited`
today, whatever it adds next — is answered **200**. There is nothing to retry,
and a run of non-2xx responses is what makes Slack disable an app's event
subscriptions. Answering that one with a 400 would eventually switch Brissa off
because Slack told us we were going too fast.

`report` is **required**, and was optional for exactly one commit before that
turned out to contradict a rule stated at the root of this repository: never
swallow an error. A default no-op discards every `failed` outcome there is, and
the caller who most needs to be told is the one who never thought about it.

- Slack is answered while the translation is still running — asserted as an
  order, because a flag that is only ever set later cannot be true at the moment
  it is checked, whatever the code does. `test: INV-app-24`
- A request Slack did not sign reaches nothing at all — not the model, not
  anybody's channel. `test: INV-app-25`
- A request too old to trust is refused, however well signed. `test: INV-app-26`
- The setup handshake is answered with the challenge and nothing else; failing it
  means the app can never be installed. `test: INV-app-27`
- An envelope we cannot use is not answered with success. `test: INV-app-28`
- A redelivery does the work once and is still answered with success — a retry is
  not an error, and reporting one would only produce another retry.
  `test: INV-app-29`
- What happened is reported once the work is done, not when it was answered.
  `test: INV-app-30`
- A reporter that throws does not take the process down after the fact. `done`
  resolves long after the request that produced it was answered, so an unhandled
  rejection there would surface with nothing to attach it to. `test: INV-app-31`
- With no clock injected it uses the real one. Every other test here hands the
  edge a fixed `now`, so none of them exercises the branch production runs on.
  `test: INV-app-32`
- An unsigned request never reaches the record of what was already seen. If
  deduplication ran before the signature check, anyone who could guess an event
  id could silence the real delivery of it — no error anywhere, just a
  translation that never appeared. `test: INV-app-33`
- A body that is valid JSON and not an object is answered, not thrown.
  `test: INV-app-34`
- Something Slack sends that we do not handle is not answered with an error.
  `test: INV-app-35`

## Why these tests are different from every other suite here

They are the only ones that can fail because two modules disagree. A per-module
suite cannot see a translation rendered into blocks nobody sends, a skip that
spends a model call anyway, or a refusal counted as a delivery.

So they assert on **what the fakes recorded**, and above all on what they
recorded nothing of. An absence of side effects is not observable any other way,
and it is exactly what the gates could never check: coupling rules and invariant
anchoring control the *shape* of a change, never its behaviour.

`deepEqual` against the whole recorded list, never `.some()` — a test asking
whether the right call happened passes happily while three wrong ones happen
beside it.

`INV-app-19` is the one that fakes only the network edges. Each part it exercises
has its own test elsewhere — `INV-llm-01` and `INV-llm-08` for the adapter,
`INV-core-12` for language names — and what is untested anywhere else is their
**composition**: the JSON the model returns becoming a block a reader can read,
with no fake standing between them.

## The shortcut: one rule removed, one added

`shortcut.ts` is the same pipeline as `handle.ts` with two changes, and both
follow from one fact — **the reader asked for this**.

**`shouldAsk` is not consulted.** Every rule in it decides whether a translation
is worth appearing *unprompted*: is the channel on, is this a bot, is it your own
message, is there anything to read. Somebody who clicked has answered all of
them, and re-asking would mean refusing a request on the grounds that nobody
requested it. The channel policy in particular must not apply — the whole point
is that this works in channels Brissa is not in and cannot see.

**It always answers.** On the automatic path silence is the product. Here a click
that produces nothing is a broken button, so every path ends in something the
reader can act on: the translation, or one line saying why there is none.

The reader is looked up by **who clicked**, never by who is in the channel. The
answer goes to one person by construction, so the languages must be theirs.

- A channel Brissa was never switched on in is still translated on request.
  `test: INV-app-45`
- Your own message is translated when you ask for it. `test: INV-app-46`
- A click always gets an answer, even when there is nothing to translate.
  `test: INV-app-47`
- A failure is told to the person waiting on it, whether the port returned it or
  threw it. `test: INV-app-48`
- Somebody Brissa has never heard of is told so rather than ignored — the first
  thing a new person does is click the button, and meeting them with nothing is
  indistinguishable from being broken. `test: INV-app-49`
- The reader is whoever clicked, not whoever is in the channel. `test: INV-app-50`
- A shortcut this app does not own is left alone. `test: INV-app-51`
- An answer that could not be sent is its own outcome, distinct from having
  nothing to say. `test: INV-app-52`
- A directory that breaks is reported rather than answered. `test: INV-app-53`

## Configuration, and the composition root

`config.ts` turns the environment into the two facts Brissa cannot run without:
who reads what, and where it is switched on. Both live in `.env` because
`src/store` serves them from a literal, and this is the file that changes on the
day they come from somewhere else.

It reports every problem at once rather than throwing on the first. The person
reading that message is doing setup for the first time, and telling them one
thing four times is four restarts.

`main.ts` is the composition root: the only file where a port meets a real thing,
the only one that reads `process.env`, and the only one where the Anthropic SDK,
Slack's websocket and a set in memory appear together. Everything above it can be
tested without a network because this is where the network is. It is guarded so
importing it does not start it.

It is the one file excluded from mutation testing, and the exclusion is the
argument for keeping it empty: a composition root scores zero because there is
nothing in it to get wrong except which name is bound to which. The moment a
decision appears here it should move to a file that is measured — which is
exactly why `describe` lives in `report.ts` rather than four lines above.

The channel id is printed on every line it logs, for one unglamorous reason:
switching Brissa on in a channel requires that channel's id, and Slack's own
interface does not show it anywhere. Watching a message arrive is how you find
out what to put in `BRISSA_CHANNELS`.

- A reader is a person and the languages they read, in their order — the first is
  the one messages are translated into, so `es,en` and `en,es` are different
  people to serve. `test: INV-app-36`
- A reader with no languages is refused rather than created. `shouldAsk` reads an
  empty list as "has not finished setting up" and stays silent, which from the
  outside is indistinguishable from Brissa being broken. `test: INV-app-37`
- An entry that is not a reader says so by name. `test: INV-app-38`
- A channel is off unless it is listed, and no channels is not an error but the
  honest first state. `test: INV-app-39`
- Every problem is reported at once, not the first one. `test: INV-app-40`
- The model is the one that was measured unless something says otherwise — named
  here rather than defaulted inside the adapter, because which model runs is a
  decision recorded in `docs/DECISIONS.md` and scored by the eval.
  `test: INV-app-41`
- A message nobody was told about says why in one word. `test: INV-app-42`
- Readers are counted by what happened to them, and skips by their reason: a run
  of thirty `channel-disabled` and one delivery should read as two numbers, not
  thirty-one lines. `test: INV-app-43`
- A failure is spelled out rather than counted away. Everything else there is a
  tally; a failure is the one outcome where the number tells you nothing and the
  reason is the whole message. `test: INV-app-44`

## The command: a second door, and why it still needs a translation each time

`/translate` is the shortcut's `shouldAsk`-free, always-answers rule again — the
same two changes, for the same reason: somebody asked. What is new is where the
text comes from. The shortcut already has it, in the payload Slack sent when
somebody clicked a specific message. A command has typed a channel and,
sometimes, a number or a sentence — it has to go and find the message itself,
through `History`, before there is anything to translate at all.

That lookup is why this flow, alone among the ones in this file, can fail in a
way the shortcut cannot: a broken `History` read. It is treated exactly like a
broken `Directory` — reported as its own outcome, not answered, because an
infrastructure failure is not something the person waiting on a click can act
on the way "translate that again" is.

**One honest gap.** When `History` finds nothing to point at — an empty
channel, or a caller who has only ever talked to themselves — there is no
notice in `render.ts` that says that precisely. `already-readable` is reused
because refusing to answer at all is worse, but its wording ("this is already in
a language you read") is not quite true of an empty result. Fixing that
precisely needs a new `Notice`, which means editing `src/core/render.ts`; this
module does not own that file, so the mismatch is recorded here rather than
patched around it.

**A partial failure is still visible.** Translating several messages at once
means several independent translator calls, and one of them failing must not
quietly shrink the reply to "everything worked" — the failure notice rides
alongside whatever did translate, once, rather than being dropped or repeated
once per failed message.

- No argument translates the most recent message that is not the caller's own.
  `test: INV-app-54`
- An explicit count translates the last N messages, including the caller's own
  — asking for a number is itself the request that `own-message` exists to wait
  for. `test: INV-app-55`
- Literal text is translated directly, without `History` being asked anything
  at all — the argument already said what to translate.
  `test: INV-app-56`
- A target that produces nothing is still answered, not left silent — a
  command that finds nothing is a broken button, the same as it is for the
  shortcut. `test: INV-app-57`
- A translation failure among several successes stays visible, never silently
  dropped, and a batch that fails entirely answers with the failure itself
  rather than an empty success. `test: INV-app-58`
- A directory failure is reported rather than answered. `test: INV-app-59`
- A history failure is reported rather than answered, for the same reason a
  directory failure is: it is somebody's job to fix, not the caller's to be
  told to retry. `test: INV-app-60`
- Somebody Brissa has never heard of is told so, not ignored — and the reader
  is looked up before `History` is ever asked anything, so a stranger costs no
  read at all. `test: INV-app-61`
- A slash command this app does not own is left alone. `test: INV-app-62`
- An answer that could not be sent is its own outcome, distinct from having
  nothing to say. `test: INV-app-63`
- Nothing here writes to a log, a file, or any store — a full run, from lookup
  to reply, makes no call to any logging surface. Restraint applies to where a
  message's text can end up, not only to whether Brissa speaks in the channel.
  `test: INV-app-64`

## Still missing

A way to say "translate for me" from inside Slack existed only as `BRISSA_READERS`,
an environment variable on somebody's machine — every new person meant editing
that file and restarting the process, which does not scale past one and was the
whole reason nobody else on the team could use Brissa. `enrol.ts` is that door:
`/brissa es en` to say what you read, `/brissa` to see what Brissa currently
thinks, `/brissa off` to stop. `main.ts` points a real `Enrolment` at it, so
unlike the HTTP path below this one is reachable by anybody in the workspace.

`handleRequest` still has nothing pointed at it: `manifest.json` enables Socket
Mode and declares no request URL, so Slack never POSTs events. The HTTP path is
finished and unreached, which is the right default for something nobody chose to
expose. What *is* exposed is `server.ts` below — the listener OAuth needed, which
`main.ts` starts — and it serves the callback and a health check, nothing else.
And nothing counts anything. `report` prints a line to a terminal.

## Two things the anchor decides

- Text you typed yourself is not quoted back at you. `test: INV-app-65`
- A message somebody else wrote still carries who wrote it. `test: INV-app-66`
- A missing user token is a working state rather than a fault: `/translate`
  cannot read a channel and says so, while the shortcut carries its own text and
  is unaffected. Requiring it would make everyone grant a broad read permission
  for a feature that never needed one. `test: INV-app-67`
- Nobody translates a channel with somebody else's account. `test: INV-app-68`
- An unverified account is refused too. `test: INV-app-69`
- Text you hand over needs no account at all. `test: INV-app-70`

## Streaming, and the two things that make it safe

A `/translate 5` used to be twenty seconds of nothing followed by everything.
Now each translation goes out as it is ready — but only under two rules, and
both exist because getting them wrong is worse than not streaming at all.

**Nothing overtakes anything.** A conversation read out of sequence is not a
conversation. A finished translation waits for every earlier one, so if the
first, second and fourth are done, the first two go out and the fourth waits for
the third. Only a contiguous prefix is ever emitted.

**One answer is always held back.** `response_url` accepts five. A stream that
spent all five on progress would have nothing left to deliver the remainder, and
the tail would vanish with nothing saying so. Four go out as the conversation
fills in; the fifth carries whatever is left, however much that is.

A third rule fell out of building it, and it was a real defect for one commit: a
failure that lands *after* everything before it has already been sent has nothing
to ride along with. It is reported on its own rather than dropped — from the
outside, a missing translation and a translation nobody attempted look identical.

Translations run four at a time. That is not a throughput knob: it is the ceiling
on how many model calls one person's command can have in flight, and twenty of
those fired together is a self-inflicted rate limit.

- A later message never overtakes an earlier one. `test: INV-app-71`
- What is ready goes out without waiting for what is not. `test: INV-app-72`
- The last answer is reserved, so a tail can never be dropped. `test: INV-app-73`

## `/brissa`: the flow that writes, and the one that always answers anyway

`enrol.ts` is `command.ts`'s shape again — the same "it always answers" rule, the
same ports-in, `response_url`-out — with one structural difference: it asks
`Enrolment`, never `Directory` or `Translator`, and `Enrolment` is the one port
in this whole system this module is allowed to call `write` on. There is no
`shouldAsk` here to skip, because there is no message and no channel; the only
judgement is what a person's own three words — a language list, blank, or
`off` — should turn into on disk and in a reply.

**The reply always says which of three states the caller is in**, because the
three read differently and collapsing any two would misinform somebody: a
person Brissa has never met is told to enrol; a person who ran `/brissa off` is
told they are off; a person with languages on file is told what they are. Only
the store can tell these apart — `undefined` from `never-enrolled`, an empty
`reads` from `off` — and this module's whole job on the query path is asking
once and repeating the answer honestly.

**Off is not a second mechanism.** Writing an empty `reads` list is the entire
implementation, because `shouldAsk` in `src/core/ask.ts` already treats an
empty list as "stay silent for this reader" — the exact behaviour "stop
translating for me" needs, with no new skip reason and no flag to keep in sync
with it.

**A store failure is reported, never mistaken for an empty answer.** A `read`
that throws is not the same as a `read` that found nobody — one is
"never enrolled", an honest answer; the other is somebody's job to fix, the
same distinction `command.ts` draws between an empty directory and a broken
one.

- A bare `/brissa` reports what Brissa currently thinks the caller reads, in
  the order they gave it. `test: INV-app-74`
- A bare `/brissa` for somebody never enrolled says so — distinct from having
  turned translation off. `test: INV-app-75`
- A bare `/brissa` for somebody who turned translation off says so — distinct
  from never having enrolled. `test: INV-app-76`
- `/brissa es en` saves the languages, in order, and confirms them in words.
  `test: INV-app-77`
- `/brissa off` writes an empty enrolment and confirms translation has
  stopped. `test: INV-app-78`
- A command this app does not own is left alone. `test: INV-app-79`
- A store failure is reported as its own outcome, never answered as if nothing
  were on file. `test: INV-app-80`
- An answer that could not be sent is its own outcome, distinct from having
  nothing to say. `test: INV-app-81`
- Nothing here writes to a log, a file, or any store outside `Enrolment` — a
  full run, query, set and off alike, makes no call to any logging surface.
  `test: INV-app-82`
- A command refused before it became one still answers the person who typed it.
  Untested for two commits: `refuseCommand` is reached only from `main.ts`, which
  is excluded from both the test suite and the mutation run, so the fix for a
  silent `/translate 0` was itself uncovered. Mutation testing found it, not
  review. `test: INV-app-83`
- Enrolment has somewhere to live, and the environment can move it. The default
  is fine on a laptop and wrong on Fly, where a path outside a volume means every
  deploy forgets everybody. `test: INV-app-84`

## Listening: `server.ts`, and the door OAuth needs

Everything above this line runs with no port open at all — Socket Mode is
outbound, so there has never been anything for a browser to reach. Per-user
OAuth breaks that assumption: Slack has to redirect a browser back to a URL
Brissa owns, so something has to be listening for it to land on.

`server.ts` is that something, built the same way `http.ts` is: transport-thin
and ignorant on purpose. It exposes exactly three routes —
`GET /oauth/start`, `GET /oauth/callback`, `GET /healthz` — and knows nothing
about what an OAuth exchange is, what a token looks like, or how `state` is
signed. Those decisions arrive as `Routes`, an injected pair of functions this
file calls without inspecting; the module that actually knows what `start`
and `callback` do belongs to `src/slack` and `src/store`, not to this one.

A browser is the client on this path, never Slack — the one place in
`src/app` where that is true. `/oauth/callback`'s answer is plain text read by
a person mid-installation, not a machine that retries on anything but 2xx, so
it is never JSON and never a stack trace, and a failure is answered with one
fixed message rather than whatever the thrown error or the query string
happened to say. `code` and `state` are already sitting in the browser's
history and in every proxy log between here and Slack by the time this code
runs; this file's whole job on that path is refusing to make that worse — it
never logs the request, and never repeats a query value or an exception's own
text back into a response.

`/healthz` calls neither route. A health check that awaited `start` or
`callback` would be answering a question about them, not about whether this
process is alive — the one thing `fly.toml` now needs `/healthz` to answer
honestly, now that scale-to-zero no longer keeps this machine's absence from
mattering (see `fly.toml` and `docs/DEPLOY.md`).

`main.ts` is what joins `startServer` to a real `Routes`, and doing that needs
`src/slack/oauth.ts` and `src/store/tokens.ts` — this module owns neither and
assumes nothing about either beyond the shape of `Routes` itself.

- `/healthz` answers without calling either route, so it cannot hang on what
  they do. `test: INV-app-85`
- `/oauth/start` redirects to the location `start()` returns. `test: INV-app-86`
- `/oauth/callback` hands the callback exactly the query Slack sent, and
  answers with whatever it returns. `test: INV-app-87`
- The callback's answer is served as plain text, whatever its body looks
  like — never JSON. `test: INV-app-88`
- An unknown path gets 404 and says nothing about what routes do exist.
  `test: INV-app-89`
- A method other than GET on a known path is treated the same as an unknown
  path — nothing here accepts anything else. `test: INV-app-90`
- A callback that throws answers with one fixed message, never its own text
  or the query it was given — an exception is exactly where a `code` or a
  `state` value turns up by accident. `test: INV-app-91`
- The server closes cleanly, even with a request already answered on a
  keep-alive connection nobody ended explicitly. `test: INV-app-92`
- Nothing about a callback request reaches the console, code and state
  included. `test: INV-app-93`

## Connecting an account, and the one line the flow rests on

`connect.ts` is how each person authorises their own Slack account, so
`/translate` reads a channel as *them* rather than as whoever set Brissa up.

**The link is minted, not requested.** A browser arriving at a public URL
carries no Slack identity, so there is nothing there to bind a flow to. It is
`/brissa connect` that mints it — Slack has already told us who asked — and it
comes back in an ephemeral only they can see. That is why no route here starts a
flow: there is nowhere honest to start one from.

**The record is keyed by Slack's answer, never by the state's claim.** That is
the guard that makes credential theft impossible: whatever a link said, a token
can only ever be filed under the person who actually consented.

**`sameAccount` sits on top of it**, and buys something smaller but real. A
signed `state` proves only that Brissa minted it, not whose flow it is, so an
attacker can start the flow honestly and hand their link to somebody else.
Without the check that person is silently connected by following a link they
were given — a surprise, and consent to something they did not begin, but not
access granted to anyone else.

One adversarial review caught the missing binding. A second caught this section
claiming the binding prevented theft, when the keying already did. Both are kept
because the smaller guarantee is still worth having, and because a contract that
overstates is the thing this repository is built to refuse.

**Disconnecting is two things.** Forgetting drops Brissa's copy; revoking tells
Slack the credential is finished with. Somebody told "disconnected" while their
token still authorises reads has been told something false. Both happen — and
the local copy goes even when Slack refuses, because a credential kept *because
revoking it failed* is the worst of the three outcomes.

- Consent is filed under whoever Slack says gave it, and a flow somebody did
  not begin is refused rather than silently completed. `test: INV-app-94`
- An honest authorisation is stored against the person who gave it.
  `test: INV-app-95`
- A state that has expired is refused, and says which kind of refusal it is —
  one is somebody who left a tab open over lunch and can try again, the other is
  not. `test: INV-app-96`
- Somebody saying no is not a failure. Reading `access_denied` as a fault would
  log an incident every time a person changed their mind, which they are
  entitled to do. `test: INV-app-97`
- Nothing is stored when Slack refuses the exchange. `test: INV-app-98`
- The link carries the identity of whoever asked for it, and asks for user
  scopes only — the bot is already installed. `test: INV-app-99`
- Disconnecting drops the copy even when Slack refuses to revoke.
  `test: INV-app-100`
- Disconnecting somebody who never connected is not an error. `test: INV-app-101`
- OAuth is configured wholly or not at all. A link built from a client id with
  no secret behind it walks somebody through Slack's consent screen to a
  callback that cannot complete; "not set up" is a better answer than that.
  `test: INV-app-102`
- Credentials and preferences are kept in different files, so tidiness cannot
  put a bearer token wherever a language preference is convenient to read.
  `test: INV-app-103`
- A request target Node accepts and `URL` refuses does not take the process
  down. Node's HTTP parser is more permissive than WHATWG URL and this port is
  public; `GET http://[::1 HTTP/1.1` threw where nothing awaited it, and the
  process that holds Brissa's websocket exited. `restart = always` then made a
  script of it. `test: INV-app-104`
- A route that throws is answered, not left to take the process with it — and
  nothing of the fault reaches the browser. The guard was added after a
  malformed request target killed the process and then left untested, which
  mutation testing found rather than review. `test: INV-app-105`
- A request Node cannot even parse does not succeed, and the process survives
  it. Weaker than it first read, and said so: Node's own default already answers
  400, so this held with our handler deleted. What is genuinely ours is that the
  process is still there afterwards — it holds Brissa's websocket.
  `test: INV-app-106`
- A credential Slack has stopped honouring is dropped, not left on disk.
  Somebody who revoked Brissa in their own settings would otherwise be answered
  "could not read this channel" indefinitely, while a token nobody can use sits
  on the volume and the one action that fixes it is never suggested.
  `test: INV-app-107`
- An ordinary read failure leaves the credential alone. A closed list rather
  than a substring search: dropping a working token over a rate limit would log
  somebody out for being busy. `test: INV-app-108`
- Disconnecting tells Slack, and says so only when Slack agreed. Mutation found
  that nothing exercised a successful revocation — "disconnect revokes" was
  asserted only in the case where it does not, and the difference is whether the
  person is told their access is withdrawn or told to go and check.
  `test: INV-app-109`
- A callback with no state is refused before anything is exchanged. Slack always
  sends one back, so this fires only for a request somebody made up — which is
  exactly the request that must not reach an exchange. `test: INV-app-110`

