import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Tokens, UserTokenRecord } from '../core/tokens.ts'
import { signState, STATE_MAX_AGE_MS } from '../slack/oauth.ts'
import { completeConnection, connectUrl, disconnect, forgetIfDead, type ConnectPorts } from './connect.ts'

const SECRET = 'a-state-signing-secret'
const NOW = 1_700_000_000_000

const config = {
  clientId: '123.456',
  clientSecret: 'a-client-secret',
  redirectUri: 'https://brissa.test/oauth/callback',
  stateSecret: SECRET,
}

/** A tokens store that keeps everything in a map and remembers what it was told. */
function fakeTokens(initial: readonly UserTokenRecord[] = []) {
  const rows = new Map(initial.map((r) => [`${r.teamId}:${r.userId}`, r]))
  const forgotten: string[] = []
  const tokens: Tokens = {
    async read(teamId, userId) {
      return rows.get(`${teamId}:${userId}`)
    },
    async write(record) {
      rows.set(`${record.teamId}:${record.userId}`, record)
    },
    async forget(teamId, userId) {
      forgotten.push(`${teamId}:${userId}`)
      rows.delete(`${teamId}:${userId}`)
    },
  }
  return { tokens, rows, forgotten }
}

/** Slack answering the exchange with whoever the test says turned up. */
const exchanges = (who: { team: string; user: string }, token = 'xoxp-granted') =>
  (async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      team: { id: who.team },
      authed_user: { id: who.user, access_token: token },
    }),
  })) as unknown as typeof fetch

const wire = (over: Partial<ConnectPorts> = {}) => {
  const t = fakeTokens()
  const ports: ConnectPorts = {
    config,
    tokens: t.tokens,
    now: () => NOW,
    fetchImpl: exchanges({ team: 'T1', user: 'U-nick' }),
    ...over,
  }
  return { ports, ...t }
}

test('INV-app-94 consent is filed under whoever Slack says gave it, not whoever the link claimed', async () => {
  // The attack this exists to refuse, and the reason `sameAccount` is called
  // here rather than left to whoever wires this up.
  //
  // An attacker starts the flow honestly and receives a validly signed state
  // carrying their own identity, then sends that link to somebody else. The
  // victim authorises, genuinely, and Slack reports the victim.
  //
  // Precise about what this buys, because an earlier version of this comment
  // was not: the write below is keyed by Slack's answer, so without this check
  // the victim would be connected *to themselves* — consent to something they
  // did not begin, not access handed to anybody else. The keying is what makes
  // theft impossible; this refuses a flow nobody started.
  const w = wire({ fetchImpl: exchanges({ team: 'T1', user: 'U-victim' }) })
  const attackersLink = signState(SECRET, { teamId: 'T1', userId: 'U-attacker' }, NOW)

  const outcome = await completeConnection(w.ports, { code: 'real-code', state: attackersLink })

  assert.deepEqual(outcome, { kind: 'refused', because: 'wrong-account' })
  assert.equal(w.rows.size, 0, 'nothing may be stored when the two identities disagree')
})

test('INV-app-95 an honest authorisation is stored against the person who gave it', async () => {
  const w = wire()
  const outcome = await completeConnection(w.ports, {
    code: 'real-code',
    state: signState(SECRET, { teamId: 'T1', userId: 'U-nick' }, NOW),
  })

  assert.deepEqual(outcome, { kind: 'connected', teamId: 'T1', userId: 'U-nick' })
  assert.deepEqual(await w.tokens.read('T1', 'U-nick'), {
    teamId: 'T1',
    userId: 'U-nick',
    token: 'xoxp-granted',
  })
})

test('INV-app-96 a state that has expired is refused, and says which kind of refusal it is', async () => {
  // Told apart from a forged one on purpose: one is somebody who left the tab
  // open over lunch and can simply try again, the other is not.
  const w = wire()
  const stale = signState(SECRET, { teamId: 'T1', userId: 'U-nick' }, NOW - STATE_MAX_AGE_MS - 1000)

  assert.deepEqual(await completeConnection(w.ports, { code: 'c', state: stale }), {
    kind: 'refused',
    because: 'expired-state',
  })

  const forged = signState('not-the-secret', { teamId: 'T1', userId: 'U-nick' }, NOW)
  assert.deepEqual(await completeConnection(w.ports, { code: 'c', state: forged }), {
    kind: 'refused',
    because: 'bad-state',
  })
  assert.equal(w.rows.size, 0)
})

test('INV-app-97 somebody saying no is not a failure', async () => {
  // Slack sends `error=access_denied` when a person declines. Reading that as a
  // fault would put an incident in the log every time somebody changed their
  // mind, which is a thing they are entitled to do.
  const w = wire()

  // With a code alongside it, so the `error` branch is what does the refusing —
  // otherwise the missing code refuses first and this passes with the check
  // deleted, which is what it did.
  const state = signState(SECRET, { teamId: 'T1', userId: 'U-nick' }, NOW)
  assert.deepEqual(await completeConnection(w.ports, { error: 'access_denied', code: 'c', state }), {
    kind: 'refused',
    because: 'no-code',
  })
  assert.equal(w.rows.size, 0, 'a refusal must not be exchanged for a token')
})

test('INV-app-98 nothing is stored when Slack refuses the exchange', async () => {
  const refuses = (async () => ({ ok: true, status: 200, json: async () => ({ ok: false, error: 'invalid_code' }) })) as unknown as typeof fetch
  const w = wire({ fetchImpl: refuses })

  assert.deepEqual(
    await completeConnection(w.ports, { code: 'c', state: signState(SECRET, { teamId: 'T1', userId: 'U-nick' }, NOW) }),
    { kind: 'refused', because: 'exchange-failed' },
  )
  assert.equal(w.rows.size, 0)
})

test('INV-app-99 the link carries the identity of whoever asked for it', async () => {
  // Minted rather than requested: a browser at a public URL has no Slack
  // identity, so there would be nothing there to bind the flow to.
  const w = wire()
  const url = new URL(connectUrl(w.ports, { teamId: 'T1', userId: 'U-nick' }))

  assert.equal(url.origin + url.pathname, 'https://slack.com/oauth/v2/authorize')
  assert.equal(url.searchParams.get('client_id'), '123.456')
  // Only user scopes, and `scope` is absent rather than empty — the bot is
  // already installed, and asking for nothing is said by not asking.
  assert.equal(url.searchParams.get('scope'), null)
  assert.ok(url.searchParams.get('user_scope')?.includes('channels:history'))

  const state = url.searchParams.get('state') ?? ''
  const back = await completeConnection(w.ports, { code: 'c', state })
  assert.deepEqual(back, { kind: 'connected', teamId: 'T1', userId: 'U-nick' })
})

test('INV-app-100 disconnecting drops the copy even when Slack refuses to revoke', async () => {
  // A credential kept *because revoking it failed* is the worst of the three
  // outcomes: still live, still on disk, and nobody looking for it.
  const refuses = (async () => ({ ok: true, status: 200, json: async () => ({ ok: false }) })) as unknown as typeof fetch
  const t = fakeTokens([{ teamId: 'T1', userId: 'U-nick', token: 'xoxp-live' }])
  const ports: ConnectPorts = { config, tokens: t.tokens, now: () => NOW, fetchImpl: refuses }

  const result = await disconnect(ports, { teamId: 'T1', userId: 'U-nick' })

  assert.deepEqual(result, { revokedAtSlack: false })
  assert.deepEqual(t.forgotten, ['T1:U-nick'])
  assert.equal(await t.tokens.read('T1', 'U-nick'), undefined)
})

test('INV-app-101 disconnecting somebody who never connected is not an error', async () => {
  const t = fakeTokens()
  const ports: ConnectPorts = { config, tokens: t.tokens, now: () => NOW }
  assert.deepEqual(await disconnect(ports, { teamId: 'T1', userId: 'U-nobody' }), { revokedAtSlack: false })
})

test('INV-app-107 a credential Slack has stopped honouring is dropped, not left on disk', async () => {
  // Otherwise somebody who revoked Brissa in their own Slack settings is
  // answered "could not read this channel" indefinitely, while a token nobody
  // can use sits on the volume — and the one action that fixes it is never
  // suggested to them.
  const t = fakeTokens([{ teamId: 'T1', userId: 'U-nick', token: 'xoxp-dead' }])
  const ports: ConnectPorts = { config, tokens: t.tokens, now: () => NOW }
  const who = { teamId: 'T1', userId: 'U-nick' }

  for (const dead of ['invalid_auth', 'token_revoked', 'token_expired', 'account_inactive']) {
    await t.tokens.write({ teamId: 'T1', userId: 'U-nick', token: 'xoxp-dead' })
    assert.equal(await forgetIfDead(ports, who, dead), true, dead)
    assert.equal(await t.tokens.read('T1', 'U-nick'), undefined, dead)
  }
})

test('INV-app-108 an ordinary read failure leaves the credential alone', async () => {
  // A closed list rather than a substring search. "Does this error mention
  // auth" is the kind of test that starts matching things it should not, and
  // dropping a working token over a rate limit would log somebody out for
  // being busy.
  const t = fakeTokens([{ teamId: 'T1', userId: 'U-nick', token: 'xoxp-fine' }])
  const ports: ConnectPorts = { config, tokens: t.tokens, now: () => NOW }
  const who = { teamId: 'T1', userId: 'U-nick' }

  for (const alive of ['ratelimited', 'http_500', 'transport: network', 'channel_not_found', 'not_in_channel']) {
    assert.equal(await forgetIfDead(ports, who, alive), false, alive)
  }
  assert.deepEqual(t.forgotten, [])
  assert.ok(await t.tokens.read('T1', 'U-nick'))
})
