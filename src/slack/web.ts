/**
 * The real Slack client, which is one HTTP call.
 *
 * No SDK. `SlackApi` is one method wide and `chat.postEphemeral` is a POST with
 * a bearer token and a JSON body — a dependency here would be a package tree, a
 * release cadence and a changelog to follow, all to avoid writing the twelve
 * lines below.
 *
 * What it must not do is throw. `sendEphemeral` reads `ok` and `error` and turns
 * them into outcomes the rest of the system already understands; a network
 * failure that escaped as an exception would arrive somewhere with no vocabulary
 * for it.
 */

import type { EphemeralRequest, SlackApi } from './send.ts'

const ENDPOINT = 'https://slack.com/api/chat.postEphemeral'

export function createSlackApi(botToken: string, fetchImpl: typeof fetch = fetch): SlackApi {
  return {
    async postEphemeral(request: EphemeralRequest) {
      try {
        const response = await fetchImpl(ENDPOINT, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${botToken}`,
            'content-type': 'application/json; charset=utf-8',
          },
          body: JSON.stringify(request),
        })

        // Slack answers 200 with `ok: false` for application errors, and a
        // non-200 for the ones that never reached the application — a revoked
        // token, a rate limit. Both have to come back in the same shape.
        if (!response.ok) return { ok: false, error: `http_${response.status}` }

        const body = (await response.json()) as { ok?: boolean; error?: string }
        return body.ok === true ? { ok: true } : { ok: false, error: body.error ?? 'unknown' }
      } catch (err) {
        // A DNS failure, a dropped socket, a body that is not JSON. Reported as
        // a refusal rather than thrown, because the caller's whole design is
        // that a translation which failed to appear must be visible as such.
        return { ok: false, error: `transport: ${String((err as Error)?.message ?? err)}` }
      }
    },
  }
}
