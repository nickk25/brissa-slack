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
 * **The identity is Slack's answer, never the state's claim.** This is the one
 * thing in the file that is a security property rather than a design
 * preference, and it is the bug an adversarial review of `oauth.ts` caught
 * before any of this was wired: a signed `state` proves only that Brissa minted
 * it, not whose flow it belongs to. An attacker can start the flow honestly,
 * obtain a validly signed state carrying their own identity, and send that link
 * to somebody else — whose real consent then arrives attached to the attacker's
 * name. `sameAccount` is what refuses that, and it is called here rather than
 * left to whoever wires this up, because a check somebody has to remember is a
 * check that will one day be forgotten.
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

  // The line the whole flow rests on. Slack has just told us whose consent this
  // is; the state told us whose flow it was meant to be. If they differ,
  // somebody has been walked through an authorisation they did not start, and
  // storing it would file their access under another person's name.
  const who: OAuthState = { teamId: exchanged.teamId, userId: exchanged.userId }
  if (!sameAccount(state.payload, who)) return { kind: 'refused', because: 'wrong-account' }

  // Keyed by Slack's answer, never by the state's claim — even now that the two
  // are known to agree, because the next person to read this should not have to
  // reconstruct why that was safe.
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
