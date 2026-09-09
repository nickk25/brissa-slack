import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  authorizeUrl,
  exchangeCode,
  readState,
  sameAccount,
  signState,
  STATE_MAX_AGE_MS,
  revokeAtSlack,
  USER_SCOPES,
} from './oauth.ts'

const SECRET = 'a-state-signing-secret'
const NOW_MS = 1_700_000_000_000
const WHO = { teamId: 'T1', userId: 'U1' } as const

test('INV-slack-80 authorizeUrl requests only the four history user scopes, and no bot scope at all', () => {
  const url = new URL(
    authorizeUrl({ clientId: 'C1', redirectUri: 'https://brissa.example/callback', state: 'st4t3' }),
  )
  assert.equal(url.origin + url.pathname, 'https://slack.com/oauth/v2/authorize')
  assert.equal(url.searchParams.get('client_id'), 'C1')
  assert.equal(url.searchParams.get('redirect_uri'), 'https://brissa.example/callback')
  assert.equal(url.searchParams.get('state'), 'st4t3')
  assert.equal(url.searchParams.get('user_scope'), 'channels:history,groups:history,im:history,mpim:history')
  // No bot install lives in this flow, so there is no field for one to leak
  // into — asking for a bot scope here would silently reopen permissions
  // this flow has no business touching.
  assert.equal(url.searchParams.get('scope'), null)
})

test('INV-slack-81 the requested user scopes match manifest.json exactly', () => {
  // Same discipline as INV-slack-61 in history.test.ts: what this flow asks
  // for and what manifest.json declares must be the same list, or one of the
  // two is lying about what Brissa actually requests.
  const manifest = JSON.parse(readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8')) as {
    oauth_config: { scopes: { user?: readonly string[] } }
  }
  assert.deepEqual([...USER_SCOPES].sort(), [...(manifest.oauth_config.scopes.user ?? [])].sort())
})

test('INV-slack-82 a state signed and read back before it expires returns the same payload', () => {
  const raw = signState(SECRET, WHO, NOW_MS)
  const result = readState(SECRET, raw, NOW_MS + STATE_MAX_AGE_MS - 1)
  assert.deepEqual(result, { ok: true, payload: WHO })
})

test('INV-slack-83 a state past its expiry is refused, and the boundary itself still verifies', () => {
  const raw = signState(SECRET, WHO, NOW_MS)
  // One millisecond past the window: refused.
  assert.deepEqual(readState(SECRET, raw, NOW_MS + STATE_MAX_AGE_MS + 1), { ok: false, because: 'expired' })
  // Exactly at the window: still good. The boundary is inside, not outside,
  // the same off-by-one `verify.ts` is careful to name in its own tests.
  assert.deepEqual(readState(SECRET, raw, NOW_MS + STATE_MAX_AGE_MS), { ok: true, payload: WHO })
})

test('INV-slack-84 a state signed with a different secret is refused', () => {
  const raw = signState('not-the-secret', WHO, NOW_MS)
  assert.deepEqual(readState(SECRET, raw, NOW_MS), { ok: false, because: 'bad-signature' })
})

test('INV-slack-85 a state altered after signing is refused', () => {
  const raw = signState(SECRET, WHO, NOW_MS)
  const dot = raw.indexOf('.')
  // Flip the case of the encoded body without touching the signature —
  // exactly what a parse-and-reserialise, or a tampered query parameter,
  // would look like from here.
  const body = raw.slice(0, dot)
  const signature = raw.slice(dot + 1)
  const tampered = `${body === body.toUpperCase() ? body.toLowerCase() : body.toUpperCase()}.${signature}`
  assert.deepEqual(readState(SECRET, tampered, NOW_MS), { ok: false, because: 'bad-signature' })
})

test('INV-slack-86 a state with no signature separator is refused rather than thrown', () => {
  assert.deepEqual(readState(SECRET, 'not-a-signed-state-at-all', NOW_MS), { ok: false, because: 'malformed' })
})

test('INV-slack-87 a signature of the wrong length is refused, not thrown', () => {
  // `timingSafeEqual` throws on a length mismatch, and a crash in the one
  // place an attacker controls the input is its own problem — the same
  // guard `verify.ts` states for Slack's own request signatures.
  const raw = signState(SECRET, WHO, NOW_MS)
  const dot = raw.indexOf('.')
  const shortened = `${raw.slice(0, dot)}.short`
  assert.deepEqual(readState(SECRET, shortened, NOW_MS), { ok: false, because: 'bad-signature' })
})

/** Signs an arbitrary JSON-serialisable body with the real secret, bypassing `signState`'s own shape. */
const signRawBody = (secret: string, body: object): string => {
  const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url')
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url')
  return `${encoded}.${signature}`
}

test('INV-slack-88 a validly-signed body that is not our own shape underneath is refused as malformed, not accepted', () => {
  // A signature only proves the bytes were not altered after signing; it
  // says nothing about whether they were ever one of ours to begin with —
  // each of these is signed with the real secret and would pass a signature
  // check alone.
  //
  // The `__proto__` case is built through `JSON.parse` rather than as an
  // object literal: `{ __proto__: 'U1' }` in source is special JS syntax
  // that sets the prototype slot instead of creating an own property, which
  // would silently produce a payload with no such key at all and prove
  // nothing. `JSON.parse` uses `CreateDataProperty`, so this really does
  // carry an ordinary own property named "__proto__" — refused here by the
  // same exact-shape check as every other case, not by a dedicated guard;
  // see `isOAuthState`'s own comment for why no dedicated guard is needed.
  const protoPayload = JSON.parse('{"teamId":"T1","__proto__":"U1"}') as Record<string, unknown>
  assert.ok(Object.prototype.hasOwnProperty.call(protoPayload, '__proto__'))

  const cases = [
    { hello: 'world' }, // no exp, no payload at all
    { payload: WHO, exp: 'soon' }, // exp not a number
    { payload: WHO, exp: Number.POSITIVE_INFINITY }, // exp not finite
    { payload: { teamId: 'T1' }, exp: NOW_MS + 1000 }, // payload missing userId
    { payload: { teamId: 'T1', userId: 42 }, exp: NOW_MS + 1000 }, // userId not a string
    { payload: { teamId: '', userId: 'U1' }, exp: NOW_MS + 1000 }, // teamId empty
    { payload: ['T1', 'U1'], exp: NOW_MS + 1000 }, // payload is an array
    { payload: null, exp: NOW_MS + 1000 }, // payload is null
    { payload: { teamId: 'T1', userId: 'U1', extra: 'x' }, exp: NOW_MS + 1000 }, // unexpected extra key
    { payload: protoPayload, exp: NOW_MS + 1000 }, // unexpected key is __proto__ itself
  ]
  for (const body of cases) {
    const raw = signRawBody(SECRET, body)
    assert.deepEqual(readState(SECRET, raw, NOW_MS), { ok: false, because: 'malformed' }, JSON.stringify(body))
  }
})

test('INV-slack-89 a state claiming a longer lifetime than signState ever grants is refused, even though correctly signed', () => {
  // Only the secret's holder can produce this, so it is not a forgery path —
  // but signState never stamps an expiry further out than STATE_MAX_AGE_MS,
  // so a value claiming one did not come from a moment-old call to it.
  const raw = signRawBody(SECRET, { payload: WHO, exp: NOW_MS + STATE_MAX_AGE_MS + 1 })
  assert.deepEqual(readState(SECRET, raw, NOW_MS), { ok: false, because: 'malformed' })

  // The boundary itself is fine: exactly the maximum lifetime, signed at
  // this same instant, is exactly what signState would have produced.
  const atBoundary = signRawBody(SECRET, { payload: WHO, exp: NOW_MS + STATE_MAX_AGE_MS })
  assert.deepEqual(readState(SECRET, atBoundary, NOW_MS), { ok: true, payload: WHO })
})

test('INV-slack-90 sameAccount matches only when both the team and the user agree', () => {
  assert.equal(sameAccount(WHO, WHO), true)
  assert.equal(sameAccount(WHO, { teamId: 'T1', userId: 'U-someone-else' }), false)
  assert.equal(sameAccount(WHO, { teamId: 'T-someone-else', userId: 'U1' }), false)
})

const respond = (body: unknown, status = 200): typeof fetch =>
  (async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })) as unknown as typeof fetch

const EXCHANGE_PARAMS = {
  clientId: 'C1',
  clientSecret: 'xoxb-super-secret-app-credential',
  code: 'one-time-code-from-slack',
  redirectUri: 'https://brissa.example/callback',
}

test('INV-slack-91 exchangeCode reads the authed_user token, never the top-level bot token', async () => {
  const body = {
    ok: true,
    access_token: 'xoxb-the-bot-token-not-this-one',
    team: { id: 'T1' },
    authed_user: { id: 'U1', access_token: 'xoxp-the-users-own-token' },
  }
  const result = await exchangeCode(EXCHANGE_PARAMS, respond(body))
  assert.deepEqual(result, { ok: true, teamId: 'T1', userId: 'U1', token: 'xoxp-the-users-own-token' })
})

test('INV-slack-92 Slack refusing with a 200 is treated as a refusal, not a success', async () => {
  const result = await exchangeCode(EXCHANGE_PARAMS, respond({ ok: false, error: 'invalid_code' }))
  assert.deepEqual(result, { ok: false, detail: 'invalid_code' })
})

test('INV-slack-93 a bad status and a dropped connection are both reported, never thrown', async () => {
  const refused = await exchangeCode(EXCHANGE_PARAMS, respond({}, 500))
  assert.deepEqual(refused, { ok: false, detail: 'http_500' })

  const exploding = (async () => {
    throw new Error('ECONNRESET')
  }) as unknown as typeof fetch
  const dropped = await exchangeCode(EXCHANGE_PARAMS, exploding)
  assert.equal(dropped.ok, false)
  assert.ok(!dropped.ok && dropped.detail.startsWith('transport:'))
})

test('INV-slack-94 a success response is refused by name unless every field is a real, non-empty string', async () => {
  const cases = [
    { ok: true, team: { id: 'T1' }, authed_user: {} }, // no user at all
    { ok: true, authed_user: { id: 'U1', access_token: 'xoxp-1' } }, // no team at all
    { ok: true, team: { id: 'T1' }, authed_user: { id: 'U1', access_token: '' } }, // empty token
    { ok: true, team: { id: 'T1' }, authed_user: { id: 'U1', access_token: null } }, // null token
    { ok: true, team: { id: 123 }, authed_user: { id: 'U1', access_token: 'xoxp-1' } }, // team id not a string
  ]
  for (const body of cases) {
    const result = await exchangeCode(EXCHANGE_PARAMS, respond(body))
    assert.deepEqual(result, { ok: false, detail: 'incomplete_response' }, JSON.stringify(body))
  }
})

test('INV-slack-95 an error body whose `error` field is not a real string reports a fixed placeholder instead', async () => {
  const result = await exchangeCode(EXCHANGE_PARAMS, respond({ ok: false, error: { nested: 'object' } }))
  assert.deepEqual(result, { ok: false, detail: 'unknown' })
})

test('INV-slack-96 a transport failure is classified from a fixed vocabulary, never by echoing the thrown value itself', async () => {
  // The case worth proving: something below `fetch` throws an error object
  // that itself quotes the request it was trying to make — a library
  // logging its own request on failure, say, with the secret and the code
  // both embedded in its `message` AND its `name`. Neither may surface.
  class LeakyError extends Error {
    constructor(message: string) {
      super(message)
      this.name = `client_secret=${EXCHANGE_PARAMS.clientSecret}`
    }
  }
  const leaky = (async () => {
    throw new LeakyError(`request failed: code=${EXCHANGE_PARAMS.code}`)
  }) as unknown as typeof fetch

  const result = await exchangeCode(EXCHANGE_PARAMS, leaky)
  assert.deepEqual(result, { ok: false, detail: 'transport: unknown' })

  // A thrown non-Error value is classified the same closed way.
  const throwsAString = (async () => {
    throw `client_secret=${EXCHANGE_PARAMS.clientSecret}`
  }) as unknown as typeof fetch
  assert.deepEqual(await exchangeCode(EXCHANGE_PARAMS, throwsAString), { ok: false, detail: 'transport: unknown' })
})

test('INV-slack-97 forgetting a credential is not revoking it, so this is the other half', async () => {
  // `Tokens.forget` drops Brissa's copy and the token keeps working. Somebody
  // told "disconnected" while their credential still authorises reads has been
  // told something false.
  const ok = (async () => ({ ok: true, status: 200, json: async () => ({ ok: true, revoked: true }) })) as unknown as typeof fetch
  assert.deepEqual(await revokeAtSlack('xoxp-x', ok), { revoked: true })

  // Slack answering 200 with ok:false is a refusal, not a success.
  const refused = (async () => ({ ok: true, status: 200, json: async () => ({ ok: false, error: 'invalid_auth' }) })) as unknown as typeof fetch
  assert.deepEqual(await revokeAtSlack('xoxp-x', refused), { revoked: false, because: 'refused' })

  // And a transport failure never reads the error, on a call whose header
  // carries a live bearer token.
  const exploding = (async () => { throw new Error('connect ECONNREFUSED 1.2.3.4:443 token=xoxp-leak') }) as unknown as typeof fetch
  const out = await revokeAtSlack('xoxp-x', exploding)
  assert.deepEqual(out, { revoked: false, because: 'unreachable' })
  assert.ok(!JSON.stringify(out).includes('xoxp-leak'))
})
