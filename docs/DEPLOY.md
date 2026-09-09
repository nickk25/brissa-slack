# Deploying Brissa

This is for the first time you do this. If you have run `fly deploy` on this
app before, skip to §1.

## 0. What you are actually deploying

Brissa is not a web server. `npm start` runs
`node --experimental-strip-types --env-file-if-exists=.env src/app/main.ts`,
which opens a websocket **outward** to Slack (Socket Mode — see
`src/slack/socket.ts`) and keeps it open. It listens on no port and receives
no inbound HTTP. That one fact shapes everything below:

- There is nothing for Fly's health checks or load balancer to point at, so
  `fly.toml` has no `[[services]]` block and no port. Don't add one — it
  would be inventing a listener that doesn't exist.
- It must run continuously. A stopped machine is a Brissa that has silently
  gone offline, and — per `src/slack/socket.ts`'s own comments — a process
  that exits looks exactly like a clean shutdown, with nothing that says so.
  `fly.toml` has no `auto_stop_machines`/scale-to-zero behaviour and sets
  `[[restart]] policy = "always"` instead: one machine, always on.
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

A `fly secrets set` triggers a new deploy on its own (the machine restarts
with the new values). You do not need to `fly deploy` again just because a
secret changed.

Note: `.env.example` also documents `SLACK_SIGNING_SECRET`, for the HTTP
request-verification path in `src/slack/verify.ts` / `src/app/http.ts`.
`src/app/main.ts` — what actually runs in production — never wires that path
up; it only ever calls `connectSocketMode`. Socket Mode's own proof of origin
is the connection itself (see the comment at the top of `socket.ts`), so
there is deliberately no signing secret to set here.

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
changes. There's no separate database, no volume, no load balancer to add to
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

There is no health-check endpoint — see §7. What you have instead is what
the process prints on startup and on every message it handles:

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

- **No health check.** There is no HTTP surface to check. The honest signal
  that Brissa is alive is its own log lines (§5) and `fly status`. If Fly
  ever reports the machine as up but the websocket has silently wedged
  without hitting `reconnect`, nothing here would notice.
- **No metrics.** Counts of messages seen, translated, or skipped exist only
  as log lines, not as anything queryable.
- **No persistence across restarts.** `src/store/memory.ts` and
  `src/store/seen.ts` hold readers, channel policy, and the
  already-handled-event set entirely in memory. Every deploy — including a
  secret change, which triggers one — throws all of it away. Slack's own
  redelivery window is short (a few retries over a few seconds), so this
  is a small and bounded risk of a rare duplicate translation right after a
  restart, not silent data loss — but it is real, and there is currently no
  database (`src/store/`'s own header says so).
