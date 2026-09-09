/**
 * The environment, turned into the two facts Brissa cannot run without.
 *
 * Who reads what, and where Brissa is switched on. Both live in `.env` today
 * because `src/store` serves them from a literal, and this is the file that has
 * to change on the day they come from somewhere else.
 *
 * Everything here reports what is wrong rather than throwing. A process that
 * dies on a malformed variable tells you the first thing it disliked and nothing
 * about the other three, and the person reading that message is doing setup for
 * the first time.
 */

import type { ChannelPolicy, Reader } from '../core/ports.ts'

export interface Config {
  readonly botToken: string
  readonly appToken: string
  /**
   * Reads channel history **as the person who asked**, and only then.
   *
   * Optional, and its absence is a working state rather than a fault: without it
   * `/translate` cannot read a channel and says so, while the message-menu
   * shortcut carries its own text and keeps working. Requiring it would make
   * everyone grant a broad read permission to use a feature that never needed
   * one.
   */
  readonly userToken: string | undefined
  /**
   * Where enrolment is kept.
   *
   * A path rather than a directory decision made inside the store, because only
   * this module reads the environment — and on Fly this has to point at a
   * volume, or every deploy forgets everybody.
   */
  readonly enrolmentPath: string
  /**
   * Where each person's own Slack token is kept, once they have connected one.
   *
   * A separate file from enrolment, and separate on purpose: one holds language
   * preferences and the other holds bearer credentials. Merging them for
   * tidiness would put a credential wherever a preference is convenient to read.
   */
  readonly tokensPath: string
  /**
   * Signs the OAuth `state`, and verifies Slack's own request signatures when
   * anything arrives over HTTP.
   *
   * One secret with two uses rather than a second one nobody remembers to set —
   * both are "prove this came from where it claims", and both are Slack's.
   */
  readonly signingSecret: string
  /** What the HTTP server listens on. Fly forwards to it; nothing else uses it. */
  readonly port: number
  /**
   * What per-person OAuth needs. All three or none: a half-configured flow
   * hands somebody a link that cannot complete, which is worse than a command
   * that says the feature is off.
   */
  readonly oauth:
    | { readonly clientId: string; readonly clientSecret: string; readonly publicUrl: string }
    | undefined
  readonly model: string
  readonly readers: readonly Reader[]
  readonly channels: readonly ChannelPolicy[]
}

export type Configured = { readonly ok: true; readonly config: Config } | { readonly ok: false; readonly problems: readonly string[] }

/** `U123:es,en;U456:de` — one person per entry, languages in the order they prefer. */
export function readReaders(raw: string): { readers: Reader[]; problems: string[] } {
  const readers: Reader[] = []
  const problems: string[] = []

  for (const entry of raw.split(';').map((e) => e.trim()).filter(Boolean)) {
    const [userId, languages] = entry.split(':')
    if (!userId || !languages) {
      problems.push(`BRISSA_READERS: "${entry}" is not "U123:es,en"`)
      continue
    }
    const reads = languages.split(',').map((l) => l.trim().toLowerCase()).filter(Boolean)
    if (reads.length === 0) {
      // The one case that must not become a reader: `shouldAsk` treats an empty
      // list as "has not finished setting up" and stays silent, which would look
      // exactly like Brissa being broken.
      problems.push(`BRISSA_READERS: "${userId}" lists no languages`)
      continue
    }
    readers.push({ userId: userId.trim(), reads })
  }

  return { readers, problems }
}

/** `C123,C456` — the channels somebody has switched Brissa on in. */
export function readChannels(raw: string): ChannelPolicy[] {
  return raw
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
    .map((channelId) => ({ channelId, enabled: true }))
}

/**
 * Every problem at once, not the first one.
 *
 * The default model is named here rather than in `src/llm`, because which model
 * runs is a decision recorded in `docs/DECISIONS.md` and measured by the eval —
 * not a default buried in an adapter.
 */
/**
 * The OAuth three, or nothing.
 *
 * Absent is a working state: `/brissa connect` says the feature is off and
 * everything else carries on. What must not happen is a partial one — a link
 * built from a client id with no secret behind it takes somebody through
 * Slack's consent screen to a callback that cannot complete, which is a worse
 * answer than "not set up".
 */
function oauthFrom(env: Record<string, string | undefined>) {
  const clientId = env.SLACK_CLIENT_ID?.trim()
  const clientSecret = env.SLACK_CLIENT_SECRET?.trim()
  const publicUrl = env.BRISSA_PUBLIC_URL?.trim()
  // The signing secret belongs in this list even though it is not an OAuth
  // credential: it is what signs the `state`, and a state signed with an empty
  // string is not signed at all. Anyone could then mint one.
  if (!clientId || !clientSecret || !publicUrl || !env.SLACK_SIGNING_SECRET?.trim()) return undefined
  return { clientId, clientSecret, publicUrl: publicUrl.replace(/\/+$/, '') }
}

export function readConfig(env: Record<string, string | undefined>): Configured {
  const problems: string[] = []

  const botToken = env.SLACK_BOT_TOKEN?.trim() ?? ''
  const appToken = env.SLACK_APP_TOKEN?.trim() ?? ''
  if (!botToken) problems.push('SLACK_BOT_TOKEN is empty (app settings → OAuth & Permissions)')
  if (!appToken) problems.push('SLACK_APP_TOKEN is empty (app settings → Basic Information → App-Level Tokens)')
  if (!env.ANTHROPIC_API_KEY?.trim()) problems.push('ANTHROPIC_API_KEY is empty')

  const { readers, problems: readerProblems } = readReaders(env.BRISSA_READERS ?? '')
  problems.push(...readerProblems)
  if (readers.length === 0) {
    problems.push('BRISSA_READERS is empty — nobody to translate for, so Brissa would run and never speak')
  }

  // No channels is not a problem. They are off until somebody switches one on,
  // which is this product's whole disposition — starting with none is the honest
  // first state rather than a misconfiguration.
  const enrolmentPath = env.BRISSA_ENROLMENT_PATH?.trim() || 'data/enrolment.json'
  const tokensPath = env.BRISSA_TOKENS_PATH?.trim() || 'data/tokens.json'
  if (enrolmentPath === tokensPath) {
    // The contract says credentials and preferences live apart so tidiness
    // cannot put a bearer token wherever a language preference is convenient to
    // read. Said in prose it is a hope; refused here it is a rule.
    problems.push('BRISSA_TOKENS_PATH and BRISSA_ENROLMENT_PATH point at the same file — credentials and preferences are kept apart')
  }

  const channels = readChannels(env.BRISSA_CHANNELS ?? '')

  if (problems.length > 0) return { ok: false, problems }

  return {
    ok: true,
    config: {
      botToken,
      appToken,
      userToken: env.SLACK_USER_TOKEN?.trim() || undefined,
      enrolmentPath,
      tokensPath,
      signingSecret: env.SLACK_SIGNING_SECRET?.trim() ?? '',
      port: Number(env.PORT?.trim()) || 8080,
      oauth: oauthFrom(env),
      model: env.BRISSA_MODEL?.trim() || 'claude-sonnet-5',
      readers,
      channels,
    },
  }
}
