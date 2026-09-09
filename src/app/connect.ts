/**
 * One person authorising their own account, from the click to the stored token.
 *
 * `/translate` reads a channel's history with a Slack user token, and until now
 * Brissa held exactly one — whoever set it up. Everybody else was refused by
 * name, because serving them would have put their request under the owner's
 * identity in Slack's access log and let the owner's memberships decide what
 * they saw. This is the flow that gives each person their own.
 *
 * **The link is minted, not requested.** A browser arriving at a public URL
 * carries no Slack identity, so there is nothing there to bind a flow to. The
 * link is instead created by `/brissa connect`, which Slack has already told us
 * came from a particular person in a particular workspace, and handed back in an
 * ephemeral only they can see. That is why there is no route here that starts a
 * flow: there is nowhere honest to start one from.
 *
 * **The identity is Slack's answer, never the state's claim**, and the record is
 * keyed by that answer. Those are two separate guards and it is worth being
 * precise about what each one buys, because an earlier version of this comment
 * was not.
 *
 * Keying by Slack's answer is what makes credential theft impossible: whatever
 * the link claimed, the token can only ever be filed under the person who
 * actually consented.
 *
 * `sameAccount` sits on top of that and buys something smaller but real. A
 * signed `state` proves only that Brissa minted it, not whose flow it is, so an
 * attacker can start the flow honestly and send their link to somebody else.
 * Without this check that person would be silently connected by following a
 * link they were handed — a surprise, and consent to something they did not
 * initiate, but not access granted to anybody else. It is refused here rather
 * than left to whoever wires this up, because a check somebody has to remember
 * is a check that will one day be forgotten.
 *
 * An adversarial review caught the missing binding; a second one caught this
 * comment overstating what restoring it had bought.
 */

import type { Tokens } from '../core/tokens.ts'
import {
  authorizeUrl,
  exchangeCode,
  readState,
  revokeAtSlack,
  sameAccount,
  signState,
  type OAuthState,
} from '../slack/oauth.ts'

export interface ConnectConfig {
  readonly clientId: string
  readonly clientSecret: string
  /** Where Slack sends the browser back. Must match what app settings hold. */
  readonly redirectUri: string
  /** Signs the state. Reuses the app's signing secret rather than inventing another. */
  readonly stateSecret: string
}

export interface ConnectPorts {
  readonly config: ConnectConfig
  readonly tokens: Tokens
  readonly now?: () => number
  /** Injected so a test needs no network. */
  readonly fetchImpl?: typeof fetch
}

/**
 * The link one person follows to authorise their own account.
 *
 * Built for the person Slack said asked for it, carrying a state signed for
 * exactly them. Handed back privately, because a link with somebody's identity
 * signed into it is not a link to paste in a channel.
 */
export function connectUrl(ports: ConnectPorts, who: OAuthState): string {
  const now = ports.now?.() ?? Date.now()
  return authorizeUrl({
    clientId: ports.config.clientId,
    redirectUri: ports.config.redirectUri,
    state: signState(ports.config.stateSecret, who, now),
  })
}

/**
 * What the person in the browser is told, and what actually happened.
 *
 * Separate on purpose: the browser gets a sentence, and the process gets a
 * reason. Handing the same string to both is how an internal detail ends up on
 * somebody's screen, and how a screen's reassurance ends up in a log.
 */
export type Connected =
  | { readonly kind: 'connected'; readonly teamId: string; readonly userId: string }
  | { readonly kind: 'refused'; readonly because: 'no-code' | 'bad-state' | 'expired-state' | 'wrong-account' | 'exchange-failed' }

export interface CallbackQuery {
  readonly code?: string | undefined
  readonly state?: string | undefined
  readonly error?: string | undefined
}

export async function completeConnection(ports: ConnectPorts, query: CallbackQuery): Promise<Connected> {
  const now = ports.now?.() ?? Date.now()

  // Slack sends `error=access_denied` when somebody says no, which is not a
  // fault and must not read as one.
  if (query.error !== undefined || !query.code) return { kind: 'refused', because: 'no-code' }
  if (!query.state) return { kind: 'refused', because: 'bad-state' }

  const state = readState(ports.config.stateSecret, query.state, now)
  if (!state.ok) {
    return { kind: 'refused', because: state.because === 'expired' ? 'expired-state' : 'bad-state' }
  }

  const exchanged = await exchangeCode(
    {
      clientId: ports.config.clientId,
      clientSecret: ports.config.clientSecret,
      code: query.code,
      redirectUri: ports.config.redirectUri,
    },
    ports.fetchImpl,
  )
  if (!exchanged.ok) return { kind: 'refused', because: 'exchange-failed' }

  // Slack has just said whose consent this is; the state said whose flow it was
  // meant to be. If they differ, somebody has been walked through an
  // authorisation they did not start — and connecting them anyway would be
  // taking a link they were handed as if it were a decision they made.
  const who: OAuthState = { teamId: exchanged.teamId, userId: exchanged.userId }
  if (!sameAccount(state.payload, who)) return { kind: 'refused', because: 'wrong-account' }

  // Keyed by Slack's answer, never by the state's claim. This is the guard that
  // makes theft impossible rather than merely unlikely: whatever a link said,
  // a token can only be filed under whoever actually consented. It stays
  // explicit even though the check above has just proven the two agree.
  await ports.tokens.write({ teamId: who.teamId, userId: who.userId, token: exchanged.token })

  return { kind: 'connected', teamId: who.teamId, userId: who.userId }
}

/**
 * Undoing it, which is two things and not one.
 *
 * Forgetting drops Brissa's copy. Revoking tells Slack the credential is
 * finished with. Somebody told "disconnected" while their token still
 * authorises reads has been told something false, so both happen — and the
 * local copy goes even when Slack refuses, because a credential kept *because
 * revoking it failed* is the worst of the three outcomes.
 */
export async function disconnect(ports: ConnectPorts, who: OAuthState): Promise<{ readonly revokedAtSlack: boolean }> {
  const record = await ports.tokens.read(who.teamId, who.userId)
  const revoked = record === undefined ? { revoked: false } : await revokeAtSlack(record.token, ports.fetchImpl)
  await ports.tokens.forget(who.teamId, who.userId)
  return { revokedAtSlack: revoked.revoked }
}

/**
 * Slack saying the credential is finished, in the words it actually uses.
 *
 * A closed list rather than a substring search, because "does this error
 * mention auth" is the kind of test that starts matching things it should not.
 * These four are what `conversations.history` answers with when the token is no
 * longer usable — revoked from the person's own Slack settings, expired, or
 * belonging to an app that was uninstalled.
 */
const DEAD_CREDENTIAL = new Set(['invalid_auth', 'token_revoked', 'token_expired', 'account_inactive'])

export function isDeadCredential(detail: string): boolean {
  return DEAD_CREDENTIAL.has(detail)
}

/**
 * Drop a credential Slack has already stopped honouring.
 *
 * Without this, somebody who revokes Brissa in their own Slack settings is
 * answered "could not read this channel" indefinitely, while a token nobody can
 * use sits on disk — and the one action that would fix it is never suggested.
 * Reacting to the failure is not as good as being told by Slack directly, and
 * it is what covers the case that actually happens.
 */
export async function forgetIfDead(ports: ConnectPorts, who: OAuthState, detail: string): Promise<boolean> {
  if (!isDeadCredential(detail)) return false
  await ports.tokens.forget(who.teamId, who.userId)
  return true
}
