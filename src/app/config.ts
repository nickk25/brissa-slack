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
  const channels = readChannels(env.BRISSA_CHANNELS ?? '')

  if (problems.length > 0) return { ok: false, problems }

  return {
    ok: true,
    config: {
      botToken,
      appToken,
      userToken: env.SLACK_USER_TOKEN?.trim() || undefined,
      model: env.BRISSA_MODEL?.trim() || 'claude-sonnet-5',
      readers,
      channels,
    },
  }
}
