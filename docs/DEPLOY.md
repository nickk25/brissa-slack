# Deploying Brissa

This is for the first time you do this. If you have run `fly deploy` on this
app before, skip to §1.

## 0. What you are actually deploying

Brissa's core is still not a web server in the way most Fly apps are. `npm
start` runs
`node --experimental-strip-types --env-file-if-exists=.env src/app/main.ts`,
which opens a websocket **outward** to Slack (Socket Mode — see
`src/slack/socket.ts`) for every message it translates automatically, and
keeps that connection open for as long as the process runs.

What changed is per-user OAuth: Slack has to redirect a person's browser back
to a URL Brissa owns to finish connecting their account, and a redirect only
works if something answers it. `src/app/server.ts` is that something — a
small `node:http` server with exactly three routes
(`/oauth/start`, `/oauth/callback`, `/healthz`), documented in
`src/app/CLAUDE.md` ("Listening: `server.ts`"). That reshapes what used to be
true here:

- `fly.toml` now has an `[[services]]` block, forwarding `443`/`80` to
  `internal_port = 8080` — the port `src/app/server.ts` is expected to
  listen on. This is **not** inventing a listener that doesn't exist any
  more; it is naming one that genuinely does.
- It must still run continuously, and for a reason that has nothing to do
  with the new port: the always-open Socket Mode websocket. A stopped
  machine is a Brissa that has silently gone offline, and — per
  `src/slack/socket.ts`'s own comments — a process that exits looks exactly
  like a clean shutdown, with nothing that says so. Adding a `[[services]]`
  block would normally hand Fly's proxy the traffic-based signal it uses to
  scale a machine to zero, which is exactly the outcome that must not
  happen here — a browser hitting `/oauth/start` once during an install
  looks, to that proxy, like the idle traffic pattern `auto_stop_machines`
  exists to notice. So `fly.toml` sets `auto_stop_machines = false` and
  `min_machines_running = 1` **explicitly**, on the service, rather than
  relying on there being no service to trigger it. `[[restart]]
  policy = "always"` is unchanged and covers the other half: the process
  itself exiting.
- The region is `fra` (Frankfurt): EU data residency for German-speaking
  clients. Brissa exists to translate for people whose Slack channels contain
  German (see `docs/DECISIONS.md`); their message content should not leave
  the EU to be relayed through it.

The Dockerfile has no build step on purpose — TypeScript is stripped at run
time, not compiled (`npm run typecheck` is a type gate, not a build). See the
comment at the top of the Dockerfile before you're tempted to add one.

## 1. One-time setup

```sh
fly auth login
fly apps create brissa          # skip if it already exists; pick another
                                 # name here (and in fly.toml) if "brissa" is
                                 # taken — app names are global on Fly
```

## 2. Secrets

Set these with `fly secrets set`. **Never** bake any of them into the image
(the Dockerfile does not, and must not) and never commit them — `.env` is
git-ignored for exactly this reason and `.env.example` must stay empty of
real values.

Read from `src/app/config.ts`, which is the actual source of truth for what's
required — this list is kept consistent with it and with `.env.example`:

**Required** (Brissa refuses to start and tells you which of these is missing
if any of them is absent):

| Secret | Where it comes from |
| --- | --- |
| `ANTHROPIC_API_KEY` | api.anthropic.com, scoped to this project only |
| `SLACK_BOT_TOKEN` | Slack app settings → OAuth & Permissions → Bot User OAuth Token |
| `SLACK_APP_TOKEN` | Slack app settings → Basic Information → App-Level Tokens (needs `connections:write`) |
| `BRISSA_READERS` | who Brissa translates for — `U123:es,en;U456:de` (see `.env.example`) |

**Optional** (absence is a working state, not a fault — see `.env.example`
and `src/app/config.ts` for what each does when unset):

| Secret | Effect when unset |
| --- | --- |
| `SLACK_USER_TOKEN` | `/translate` reports itself off; the message-menu shortcut is unaffected |
| `BRISSA_CHANNELS` | Brissa stays silent everywhere — the deliberate first state |
| `BRISSA_MODEL` | defaults to `claude-sonnet-5` (the model `docs/DECISIONS.md` measured and picked) |

```sh
fly secrets set \
  ANTHROPIC_API_KEY='sk-ant-...' \
  SLACK_BOT_TOKEN='xoxb-...' \
  SLACK_APP_TOKEN='xapp-...' \
  BRISSA_READERS='U123:es,en;U456:de' \
  --app brissa

# add these when you have them / when you're ready to turn a channel on —
# same command, run again, only sets what you pass:
fly secrets set \
  SLACK_USER_TOKEN='xoxp-...' \
  BRISSA_CHANNELS='C123,C456' \
  BRISSA_MODEL='claude-sonnet-5' \
  --app brissa
```

### Per-user OAuth: two more secrets, and a URL to register with Slack

Read by `src/app/config.ts`, which is the module that owns the word "required"
here, and needed **together**: `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`,
`SLACK_SIGNING_SECRET`, `BRISSA_PUBLIC_URL` and `BRISSA_TOKENS_KEY`. With any of
them missing, `/brissa connect` says the feature is off and everything else
carries on — a half-configured flow walks somebody through Slack's consent
screen to a callback that cannot complete, which is a worse answer than "not set
up".

| Secret | Where it comes from |
| --- | --- |
| `SLACK_CLIENT_ID` | Slack app settings → Basic Information → App Credentials |
| `SLACK_CLIENT_SECRET` | Slack app settings → Basic Information → App Credentials — treat it exactly like the other secrets on this page: `fly secrets set`, never committed, never logged |

```sh
fly secrets set \
  SLACK_CLIENT_ID='...' \
  SLACK_CLIENT_SECRET='...' \
  --app brissa
```

Slack also needs to know where to send a browser back once someone approves
the connection. In the app's settings, under **OAuth & Permissions → Redirect
URLs**, add:

```
https://brissa.fly.dev/oauth/callback
```

(`brissa.fly.dev` because that is this app's name and Fly's default domain —
see `fly.toml`'s `app = "brissa"`. If the app was ever created under a
different name, use that name's `.fly.dev` host instead.) This is the one
piece of Slack-side configuration that lives outside `fly secrets set`
entirely — it is set in Slack's own UI, not on this machine.

A `fly secrets set` triggers a new deploy on its own (the machine restarts
with the new values). You do not need to `fly deploy` again just because a
secret changed.

Note on `SLACK_SIGNING_SECRET`: it has two jobs and only one of them is live.
It verifies Slack's request signatures on the HTTP events path
(`src/slack/verify.ts`), which nothing uses while Socket Mode is on — the
connection is its own proof of origin. And it signs the OAuth `state`, which is
very much live, which is why it is required above. A state signed with an empty
string is not signed at all.

## 3. Deploy

```sh
fly deploy --app brissa
```

This builds the image from the repository root `Dockerfile` and rolls it out
as the one always-on machine `fly.toml` describes.

## 4. What it costs

Two separate bills, and only one of them is Fly's.

**Fly:** one always-on `shared-cpu-1x` machine with 256MB, in `fra`. At the
time of writing that class of machine is on the order of a few dollars a
month (Fly bills per-second for compute plus a small amount for the app
itself) — check <https://fly.io/docs/about/pricing/> for the actual current
number; this is a rough order of magnitude, not a quote, and Fly's pricing
it — the only resource this app owns is the one machine.

**Anthropic:** not Fly's bill at all, and the bigger unknown of the two. One
model call per message Brissa considers (`src/llm/decide.ts`, model set by
`BRISSA_MODEL`, `claude-sonnet-5` by default — see `docs/DECISIONS.md` for
why that model), scaling with how much traffic actually flows through the
channels in `BRISSA_CHANNELS` and how many of those messages are in a
language a reader doesn't read. Check
<https://console.anthropic.com/settings/cost> once it's been running a
while, rather than guessing up front.

## 5. How to tell it is running

`main.ts` starts `src/app/server.ts`, so the health check `fly.toml` points at
is live. `/healthz` is the fast signal:

```sh
fly checks list --app brissa
curl -i https://brissa.fly.dev/healthz     # 200, body "ok"
```

`/healthz` answers from the HTTP server and says nothing at all about the
websocket — the process can be serving 200s while Slack has stopped talking to
it. For that side, what you have is what the process prints on startup and on
every message it handles:

```sh
fly logs --app brissa
```

Look for, in order:

- `Brissa is listening as <model>.` — config loaded, process is up
- `  readers   ...` / `  channels   ...` — what it thinks it's configured for
- `  connected` — the Socket Mode websocket to Slack is live
- one line per message it decided about, e.g. `  C123  translated → es`

If instead you see `Brissa cannot start:` followed by a bullet list, a
required secret is missing or malformed — the list tells you which. If you
see `reconnecting in ...ms` repeating, the websocket keeps dropping; a tight
loop of that with increasing backoff up to 30s usually means
`SLACK_APP_TOKEN` was rejected.

```sh
fly status --app brissa     # is the one machine up, and since when
```

## 6. Rolling back

```sh
fly releases list --app brissa          # find the version to go back to
fly deploy --image <image-ref-from-that-release> --app brissa
```

(Older `flyctl` versions had a dedicated `fly releases rollback` — if your
CLI still has it, that's the shorter path; `fly releases list` shows the
image reference either way.) Because there is no state in this process
beyond an in-memory set (see §7), rolling back is just running the old image
again — there is no data migration to reverse.

## 7. What this does not do yet

Said plainly, not buried:

- **No metrics.** Counts of messages seen, translated, or skipped exist only
  as log lines, not as anything queryable.
- **Two things persist and the rest does not.** Enrolment and connected tokens
  live on the volume; the deduplication set and channel policy are memory and go
  on every restart, which is what they are for.

## What was actually created, and what it cost

Applied on 9 September 2026. Recorded because a deploy nobody wrote down is one
somebody has to rediscover from a dashboard.

| | |
| --- | --- |
| App | `brissa`, org `personal`, region `fra` |
| Machine | one `shared-cpu-1x`, 256 MB, always on |
| Volume | `brissa_data`, 1 GB, encrypted, mounted at `/data` |
| Secrets | seven, staged with `fly secrets import` and never printed |
| Image | 57 MB |

The volume exists for one file. Enrolment is the only thing Brissa is meant to
remember across a deploy; the deduplication set and channel policy are memory on
purpose and are meant to go.

`BRISSA_ENROLMENT_PATH` is `/data/enrolment.json` and is set as a secret rather
than written into `fly.toml`, so it cannot drift away from the mount without
somebody noticing.

**The first run said what it should:**

```
Mounting /dev/vdc at /data
Brissa is listening as claude-sonnet-5.
  readers   U03QMMUHTPU reads es, en
  /translate  reads history as U03QMMUHTPU, and only for them
  connected
```


## The secrets per-user OAuth added

Set with `fly secrets set`, like the others. All four are needed together — a
partial configuration takes somebody through Slack's consent screen to a
callback that cannot complete, so `readConfig` treats "some of them" as none.

| Secret | Where it comes from |
| --- | --- |
| `SLACK_CLIENT_ID` | Basic Information → App Credentials |
| `SLACK_CLIENT_SECRET` | the same panel, behind **Show** |
| `SLACK_SIGNING_SECRET` | the same panel. It signs the OAuth `state`, and a state signed with an empty string is not signed |
| `BRISSA_PUBLIC_URL` | `https://brissa.fly.dev` — no trailing slash |

And one that is not a secret but must be set anyway:

| Variable | Value |
| --- | --- |
| `BRISSA_TOKENS_PATH` | **`/data/tokens.json`** |
| `BRISSA_TOKENS_KEY` | `openssl rand -base64 32` — 32 bytes, base64 |

**It defaults to `data/tokens.json`, which on Fly is inside the container and
gone on every deploy.** Left unset, everybody who connected their account is
silently disconnected the next time this ships — and finds out only when
`/translate` starts refusing them. It belongs on the volume beside enrolment.

Register the redirect URL in Slack under **OAuth & Permissions → Redirect
URLs**, exactly:

```
https://brissa.fly.dev/oauth/callback
```

Slack compares that string character for character against what it is sent. A
trailing slash on `BRISSA_PUBLIC_URL` becomes a double slash here and the whole
flow is refused, with an error that reads like something else — which is why
`readConfig` trims them.

## What is still true about what this does not do

The tokens file is encrypted at rest with `BRISSA_TOKENS_KEY`, AES-256-GCM, on
top of `0600` and Fly's own volume encryption. Be exact about what that buys: a
snapshot, a backup, or a copy of the file taken without the environment is
noise. It buys **nothing** against anything that compromises the running
process, which holds the key by definition.

The key must live in the environment and never on the volume — `fly secrets set`
does exactly that. Losing it means every connected person has to run `/brissa
connect` again; nothing is recoverable from the file without it, which is the
point.

A credential Slack has stopped honouring — revoked from somebody's own Slack
settings, or expired — is dropped the next time it fails, and that person is
told to reconnect. There is still no subscription to Slack's own
`tokens_revoked` or `app_uninstalled` events, so this is noticed on next use
rather than immediately.

## If Brissa refuses to start

It does that on purpose in one case, and the message names the file: the tokens
store exists and cannot be opened with `BRISSA_TOKENS_KEY`. A wrong key, a key
that was rotated, or a file written before any of this was encrypted all look
the same from here — which is what an authentication tag is for.

There are two ways out and no third:

- restore the key that wrote the file, or
- delete `/data/tokens.json` and have everybody run `/brissa connect` again.

Nothing in that file is recoverable without the key. That is the point of
encrypting it, and it is why the process refuses to start rather than
discovering the problem one person at a time.
