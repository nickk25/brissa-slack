/**
 * The only place that talks to a model.
 *
 * It answers the port declared in `src/core/translator.ts` and nothing else
 * crosses back: no SDK type, no token count, no model name. The core asked a
 * question about a message and gets an answer about a message.
 *
 * The prompt is read from disk rather than inlined so that exactly one copy
 * exists — the eval measures the same bytes this ships, and a prompt that drifts
 * from the one that was scored is a prompt with no score.
 */

import Anthropic from '@anthropic-ai/sdk'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Translation } from '../core/render.ts'
import type { TranslationRequest, TranslationResult, Translator } from '../core/translator.ts'

/** The subset of the SDK used here, so the tests need no network and no key. */
export interface MessagesApi {
  create(request: {
    model: string
    max_tokens: number
    system: string
    messages: { role: 'user'; content: string }[]
    output_config: unknown
  }): Promise<{ content: { type: string; text?: string }[] }>
}

export interface DecideOptions {
  readonly model: string
  readonly promptPath: string
  /** How many times a transient failure is worth another try. */
  readonly attempts?: number
  /** Injected so a test can run without waiting out a backoff. */
  readonly sleep?: (ms: number) => Promise<void>
}

const LANGUAGE_NAMES: Record<string, string> = {
  es: 'Spanish', en: 'English', de: 'German', fr: 'French', it: 'Italian', nl: 'Dutch', pt: 'Portuguese',
}

const name = (code: string) => LANGUAGE_NAMES[code] ?? code

const SCHEMA = {
  format: {
    type: 'json_schema',
    schema: {
      type: 'object',
      properties: {
        translate: { type: 'boolean' },
        languages: { type: 'array', items: { type: 'string' } },
        text: { type: 'string' },
      },
      required: ['translate'],
      additionalProperties: false,
    },
  },
}

/**
 * A failure worth trying again.
 *
 * Overload and rate limiting are the service saying "not now"; a 4xx that is not
 * 429 is it saying "no", and repeating a request it already refused only delays
 * the report of a real problem.
 */
const transient = (err: unknown): boolean => {
  const status = (err as { status?: number })?.status ?? 0
  return status === 429 || status >= 500
}

export function createTranslator(messages: MessagesApi, options: DecideOptions): Translator {
  const attempts = options.attempts ?? 4
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const raw = readFileSync(options.promptPath, 'utf8')

  return {
    async translate(request: TranslationRequest): Promise<TranslationResult> {
      const target = request.reads[0]
      if (target === undefined) {
        // The core is meant to have stopped this already. Reaching here means a
        // caller skipped `shouldAsk`, and inventing a target language would be a
        // worse answer than saying so.
        return { kind: 'failed', detail: 'reader reads no languages' }
      }

      const system = raw
        .replaceAll('{{READS}}', request.reads.map(name).join(' and '))
        .replaceAll('{{TARGET}}', name(target))

      for (let attempt = 1; ; attempt++) {
        try {
          const response = await messages.create({
            model: options.model,
            max_tokens: 2048,
            system,
            messages: [{ role: 'user', content: request.text }],
            output_config: SCHEMA,
          })

          const block = response.content.find((c) => c.type === 'text')
          if (!block?.text) return { kind: 'failed', detail: 'model returned no text' }

          const answer = JSON.parse(block.text) as { translate?: boolean; languages?: string[]; text?: string }
          if (answer.translate !== true) return { kind: 'silent' }

          // Asked to translate and then given nothing to show is a broken answer,
          // not a quiet one. Reporting it as silence would hide the fault behind
          // the product's own normal behaviour.
          if (!answer.text) return { kind: 'failed', detail: 'model chose to translate but returned no text' }

          const translation: Translation = {
            text: answer.text,
            foundLanguages: answer.languages ?? [],
          }
          return { kind: 'translated', translation }
        } catch (err) {
          if (!transient(err) || attempt >= attempts) {
            return { kind: 'failed', detail: String((err as Error)?.message ?? err) }
          }
          await sleep(2 ** attempt * 500)
        }
      }
    },
  }
}

/** The translator this app runs with, wired to the real SDK. */
export function defaultTranslator(model: string, root = process.cwd()): Translator {
  const client = new Anthropic()
  return createTranslator(client.messages as unknown as MessagesApi, {
    model,
    promptPath: join(root, 'src/llm/prompts/decide.md'),
  })
}
