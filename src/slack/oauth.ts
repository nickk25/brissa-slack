/**
 * The Slack-facing half of letting somebody other than the app's owner read
 * with their own identity: the redirect that asks Slack for one person's
 * consent, the signed `state` that survives the round trip, and the call
 * that turns Slack's answer into a token worth storing in
 * `src/core/tokens.ts`.
 *
 * Why this exists at all is `src/slack/CLAUDE.md`'s own "slash command, and
 * the other credential" section: `/translate` reads with a user token, and
 * until now Brissa held exactly one — the person who ran it first.
 * `src/app/command.ts` refuses everybody else by name rather than quietly
 * reading under that one person's identity, because doing so would put a
 * colleague's request under the owner's name in Slack's own access log and
 * let the owner's channel memberships decide what a stranger to this file
 * gets to see. The fix is that each person authorises their own account,
 * which is what an OAuth flow is for.
 *
 * **User scope only, and nothing else.** The bot is already installed by the
 * time anyone runs this flow; this is not a second install, it is one
 * person's own read access on top of it. Asking for a bot scope here would
 * silently make Slack revisit permissions this flow has no business
 * touching, and asking for anything beyond the four `history` scopes
 * `history.ts`'s own contract already names would be asking somebody for more
 * of their own account than Brissa needs to translate a channel they can
 * already read.
 *
 * **Signed, stateless `state`, and what it does and does not prove.** Slack's
 * `state` parameter exists to stop somebody being walked through an
 * authorisation they never started — a page that links straight to Slack's
 * consent screen with no `state` at all lets an attacker send a victim their
 * own authorisation link and receive the victim's token back. `signState`/
 * `readState` follow `verify.ts` closely: the same HMAC discipline, the same
 * timing-safe comparison, the same guard against `timingSafeEqual` throwing
 * on a length mismatch instead of just saying no. The payload and its expiry
 * live *inside* the signed value rather than in a server-side session keyed
 * by some id in it, which is the deliberate difference from a typical web
 * session: this process can restart between the redirect out to Slack and
 * the redirect back — a deploy, a crash, a routine restart — and a person
 * mid-flow must not be stranded holding a `state` that now points at a
 * session nobody remembers.
 *
 * `readState` returning `ok: true` proves only that *this app* minted the
 * value, unaltered, within its window. It proves nothing about whose flow it
 * was — an attacker can start this flow honestly, receive a validly signed
 * `state` carrying their own Slack identity, and hand that value (not their
 * own login, just a query parameter) to a victim as if it were a link to
 * click. If the victim consents on Slack's real page, Slack redirects back
 * with the victim's own `code` next to the attacker's `state`, and a
 * callback that trusted the signature alone would store the victim's token
 * under the attacker's identity. `sameAccount` below exists to close exactly
 * that gap: whatever wires this flow together MUST compare the account
 * `signState` was given against the account `exchangeCode` returns, and MUST
 * key `src/core/tokens.ts` by the latter — Slack's own answer — never by the
 * former, a claim the flow made about itself before Slack ever confirmed it.
 *
 * **Never throws.** `exchangeCode` reads `ok` and `error` the same way
 * `web.ts` and `history.ts` already do, for the same reason: Slack answers
 * `200` with `ok: false` for an application error, and a non-2xx for one that
 * never reached the application at all, and a caller several `await`s away
 * from a Slack outage has no shape for an exception, only for data.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

const AUTHORIZE_ENDPOINT = 'https://slack.com/oauth/v2/authorize'
const EXCHANGE_ENDPOINT = 'https://slack.com/api/oauth.v2.access'

/**
 * Every user scope this flow may ever request, in the order Slack expects
 * them joined by a comma.
 *
 * Exactly the four scopes `manifest.json` already declares under
 * `oauth_config.scopes.user` and `history.ts`'s own contract names as the
 * ones a user token needs for `/translate` — nothing else. No bot `scope`
 * parameter is built anywhere in this file: the bot is already installed,
 * and this flow only ever asks for a person's own read access on top of it.
 */
export const USER_SCOPES = ['channels:history', 'groups:history', 'im:history', 'mpim:history'] as const

export interface AuthorizeParams {
  readonly clientId: string
  readonly redirectUri: string
  /** A value from `signState`, carried through Slack and read back with `readState`. */
  readonly state: string
}

/**
 * The URL to send somebody to so they can authorise their own account.
 *
 * Builds only `client_id`, `user_scope`, `redirect_uri` and `state` — there is
 * no parameter named `scope` anywhere in this function, which is the
 * structural version of the rule stated above: a bot scope cannot leak in by
 * accident because there is no field here for one to leak into.
 */
export function authorizeUrl({ clientId, redirectUri, state }: AuthorizeParams): string {
  const query = new URLSearchParams({
    client_id: clientId,
    user_scope: USER_SCOPES.join(','),
    redirect_uri: redirectUri,
    state,
  })
  return `${AUTHORIZE_ENDPOINT}?${query.toString()}`
}

/**
 * How long a signed `state` remains valid.
 *
 * Ten minutes, not `verify.ts`'s own five: that five-minute window bounds a
 * server-to-server request that happens in milliseconds, so five minutes is
 * already generous for its job. This bounds a *human* round trip through
 * Slack's own consent screen — including, for a workspace with SSO, a
 * redirect through an identity provider Brissa does not control — and five
 * minutes is tight enough that a person who gets interrupted mid-approval
 * would have to start over. Ten minutes covers that without leaving a
 * captured `state` useful for long.
 *
 * A signed `state` is not single-use on its own — nothing here keeps a seen
 * set of them the way `src/core/seen.ts` does for event deliveries, and nor
 * does it need to: the value that is genuinely one-time is Slack's own
 * authorization `code`, which Slack itself refuses on a second exchange.
 * What this window bounds is how long a captured `state` could be paired
 * with a *fresh* `code` before it stops verifying at all — and, once
 * `sameAccount` is enforced by the caller, pairing it with anyone else's
 * `code` gains an attacker nothing to begin with.
 */
export const STATE_MAX_AGE_MS = 10 * 60 * 1000

/**
 * Who this flow was signed for — Slack already signs both onto every command
 * and interaction that could plausibly start it, the same pair `enrolment.ts`
 * and `tokens.ts` key every record by, so asking for them here costs nothing
 * new and is exactly what `sameAccount` below has to compare against Slack's
 * own answer once the flow completes.
 */
export interface OAuthState {
  readonly teamId: string
  readonly userId: string
}

interface EncodedState {
  readonly payload: OAuthState
  /** Milliseconds since the epoch, past which this state no longer verifies. */
  readonly exp: number
}

const toBase64Url = (text: string): string => Buffer.from(text, 'utf8').toString('base64url')
const fromBase64Url = (text: string): string => Buffer.from(text, 'base64url').toString('utf8')

const mac = (secret: string, body: string): string => createHmac('sha256', secret).update(body).digest('base64url')

/**
 * @param secret   the same secret `readState` must be given to accept this back
 * @param payload  who this flow is for; read back verbatim by `readState`
 * @param nowMs    the current time in milliseconds, used to stamp the expiry
 */
export function signState(secret: string, payload: OAuthState, nowMs: number): string {
  const encoded: EncodedState = { payload, exp: nowMs + STATE_MAX_AGE_MS }
  const body = toBase64Url(JSON.stringify(encoded))
  return `${body}.${mac(secret, body)}`
}

export type StateResult =
  | { readonly ok: true; readonly payload: OAuthState }
  | { readonly ok: false; readonly because: 'malformed' | 'bad-signature' | 'expired' }

/**
 * Whether a value is exactly `{ teamId: string, userId: string }` and
 * nothing more.
 *
 * Exact key count, not merely "has these two fields", so an object carrying
 * an unexpected third key — `__proto__` among them — is refused by the same
 * check that refuses any other wrong shape, with no separate guard to keep
 * in sync. That third key could not read as data here even without this
 * function: `JSON.parse` builds an object with `CreateDataProperty`, not the
 * `[[Set]]` a `{ ...spread }` would use, so a `"__proto__"` key in the input
 * lands as an ordinary own property rather than reaching the real prototype.
 * This check exists for the shape, not for that danger — the danger was
 * never real to begin with.
 */
function isOAuthState(value: unknown): value is OAuthState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  if (Object.keys(value).length !== 2) return false
  const { teamId, userId } = value as { teamId?: unknown; userId?: unknown }
  return typeof teamId === 'string' && teamId.length > 0 && typeof userId === 'string' && userId.length > 0
}

/**
 * @param secret  the secret `signState` used to produce `raw`
 * @param raw     the `state` query parameter exactly as Slack sent it back
 * @param nowMs   the current time in milliseconds
 */
export function readState(secret: string, raw: string, nowMs: number): StateResult {
  const dot = raw.indexOf('.')
  if (dot < 0) return { ok: false, because: 'malformed' }
  const body = raw.slice(0, dot)
  const signature = raw.slice(dot + 1)

  // Same guard `verify.ts` states plainly: `timingSafeEqual` throws on a
  // length mismatch rather than returning false, and a crash in the one place
  // an attacker controls the input is its own problem. Checked, and refused,
  // before the signature is compared at all — and before the body is trusted
  // enough to parse.
  const expected = Buffer.from(mac(secret, body))
  const actual = Buffer.from(signature)
  if (expected.length !== actual.length) return { ok: false, because: 'bad-signature' }
  if (!timingSafeEqual(expected, actual)) return { ok: false, because: 'bad-signature' }

  let parsed: unknown
  try {
    parsed = JSON.parse(fromBase64Url(body))
  } catch {
    return { ok: false, because: 'malformed' }
  }

  // A signature can only be trusted to prove the body was not altered *after*
  // signing — it says nothing about whether the body was ever one of ours to
  // begin with, so the shape underneath still has to be checked before it is
  // handed back as an `OAuthState`.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, because: 'malformed' }
  }
  const { payload, exp } = parsed as { payload?: unknown; exp?: unknown }
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return { ok: false, because: 'malformed' }

  // Defence in depth, not a real forgery path: only the holder of `secret`
  // can produce a value that reaches this line at all. But `signState` never
  // stamps an expiry further out than `STATE_MAX_AGE_MS`, so a value claiming
  // one is not a state this module could have signed a moment ago — it is
  // either a bug in `signState` or a secret that has to be rotated, and
  // either way "malformed" is a truer answer than quietly accepting it.
  if (exp - nowMs > STATE_MAX_AGE_MS) return { ok: false, because: 'malformed' }

  if (!isOAuthState(payload)) return { ok: false, because: 'malformed' }
  if (nowMs > exp) return { ok: false, because: 'expired' }

  return { ok: true, payload }
}

/**
 * Whether the account Slack just authorised is the one this flow was signed
 * for.
 *
 * This check is not automatic just because `readState` said `ok: true` — see
 * the module comment above for why a valid signature proves the *state* is
 * ours without proving it belongs to whoever is holding it right now.
 * Whatever calls `exchangeCode` MUST call this too, before writing anything
 * to `src/core/tokens.ts`, and MUST key that write by `exchanged` — Slack's
 * own answer — never by `payload`.
 */
export function sameAccount(payload: OAuthState, exchanged: OAuthState): boolean {
  return payload.teamId === exchanged.teamId && payload.userId === exchanged.userId
}

export interface ExchangeParams {
  readonly clientId: string
  readonly clientSecret: string
  /** The one-time code Slack put on the redirect back to `redirectUri`. */
  readonly code: string
  readonly redirectUri: string
}

export type ExchangeResult =
  | { readonly ok: true; readonly teamId: string; readonly userId: string; readonly token: string }
  | { readonly ok: false; readonly detail: string }

/** A non-empty string, which is what every field below has to be to mean anything. */
const isFilledString = (value: unknown): value is string => typeof value === 'string' && value.length > 0

/**
 * Turns the one-time code Slack put on the redirect into the token
 * `src/core/tokens.ts` stores.
 *
 * **Reads `authed_user.access_token`, never the top-level `access_token`.**
 * Slack's response to `oauth.v2.access` carries two tokens when a flow
 * requests both bot and user scopes: the one at the top is the bot's, and
 * `authed_user.access_token` is the person's. This flow requests only a user
 * scope (see `USER_SCOPES` above), but the shape of Slack's response does not
 * change to match — the field is still nested under `authed_user`, and
 * reading the wrong one would store a credential that is not this person's at
 * all, and that half-works in exactly the way that is hardest to notice: it
 * is a real, valid Slack token, held by the app rather than by the person who
 * just went through the trouble of authorising it.
 *
 * **Every field of a claimed success is checked, not just its presence.**
 * `response.json()` is cast to a shape, same as `web.ts` and `history.ts`
 * already do, and a cast is a promise about a network response this function
 * cannot enforce by itself — `null`, a number, or an empty string would all
 * satisfy `!== undefined`. Reported as `incomplete_response` unless `teamId`,
 * `userId` and `token` are each a real, non-empty string, so this function's
 * own return type is never a promise the caller can be handed and then find
 * broken three calls later.
 *
 * Never throws, and never lets `clientSecret` or `code` — nor anything about
 * the shape of whatever failed — reach the `detail` it returns on failure.
 * The transport-failure branch below reports one of a fixed, closed set of
 * words rather than any part of the thrown value itself, which is the only
 * way to promise this for a value this function did not create and cannot
 * inspect the trustworthiness of: an error's own `message`, and even its
 * `name`, are just strings whatever threw got to choose.
 */
export async function exchangeCode(params: ExchangeParams, fetchImpl: typeof fetch = fetch): Promise<ExchangeResult> {
  try {
    const body = new URLSearchParams({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      code: params.code,
      redirect_uri: params.redirectUri,
    })
    const response = await fetchImpl(EXCHANGE_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })

    // Slack answers 200 with `ok: false` for an application error — a
    // reused code, a redirect_uri mismatch — and a non-200 for one that never
    // reached the application. Reading only the status code would treat a
    // refusal Slack described in the body as a successful exchange.
    if (!response.ok) return { ok: false, detail: `http_${response.status}` }

    const parsed = (await response.json()) as {
      ok?: boolean
      error?: unknown
      team?: { readonly id?: unknown }
      authed_user?: { readonly id?: unknown; readonly access_token?: unknown }
    }
    if (parsed.ok !== true) {
      // `parsed.error`, when Slack sent one, is a fixed Slack error code
      // (`invalid_code`, `bad_redirect_uri`, …), never an echo of what was
      // sent — but it is still untrusted network data, so its type is
      // checked before it is handed back as this function's own `detail`.
      return { ok: false, detail: isFilledString(parsed.error) ? parsed.error : 'unknown' }
    }

    const teamId = parsed.team?.id
    const userId = parsed.authed_user?.id
    const token = parsed.authed_user?.access_token
    if (!isFilledString(teamId) || !isFilledString(userId) || !isFilledString(token)) {
      return { ok: false, detail: 'incomplete_response' }
    }

    return { ok: true, teamId, userId, token }
  } catch (err) {
    // A DNS failure, a dropped socket, a body that is not JSON. Classified
    // into one of a fixed set of words, never by reading `err.message` or
    // even `err.name` — both are just strings whatever threw got to write,
    // and this function cannot promise a value it did not choose the
    // contents of will never contain `clientSecret` or `code`.
    const kind = err instanceof TypeError ? 'network' : err instanceof SyntaxError ? 'not-json' : 'unknown'
    return { ok: false, detail: `transport: ${kind}` }
  }
}
