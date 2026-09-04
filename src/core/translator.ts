/**
 * The port the core asks for a translation through.
 *
 * Declared here, in the pure half, so the core owns the shape of the question
 * and the adapter owns only the answering. An interface that lived in `src/llm`
 * would let the SDK's vocabulary creep back across the boundary one field at a
 * time.
 */

import type { Translation } from './render.ts'

/** What the model was asked, without anything about how it was asked. */
export interface TranslationRequest {
  readonly text: string
  /** The languages the reader reads. Everything else is a candidate. */
  readonly reads: readonly string[]
}

/**
 * Three outcomes, not two.
 *
 * `silent` and `failed` are both "no translation appeared", and collapsing them
 * would make an outage indistinguishable from restraint — which is precisely the
 * confusion this product cannot afford, since staying quiet is its normal
 * behaviour. One of them is the feature working and the other is somebody's job.
 */
export type TranslationResult =
  | { readonly kind: 'translated'; readonly translation: Translation }
  | { readonly kind: 'silent' }
  | { readonly kind: 'failed'; readonly detail: string }

export interface Translator {
  translate(request: TranslationRequest): Promise<TranslationResult>
}
