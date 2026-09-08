/**
 * An outcome, in one line, for whoever started the process.
 *
 * Not a metrics system and not pretending to be one. But `report` is required
 * precisely so that no caller can quietly discard a `failed`, and a process that
 * printed nothing would be a caller doing exactly that.
 *
 * Separate from `main.ts` because this is the only part of the runner with a
 * decision in it, and the composition root around it has none worth testing.
 */

import type { MessageOutcome } from './handle.ts'

export function describe(outcome: MessageOutcome): string {
  if (outcome.kind !== 'considered') return outcome.kind

  const counts = new Map<string, number>()
  for (const reader of outcome.readers) {
    const key = reader.kind === 'skipped' ? `skipped:${reader.because}` : reader.kind
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const failures = outcome.readers.filter((r) => r.kind === 'failed')
  const summary = [...counts].map(([k, n]) => `${k}×${n}`).join(' ')

  return failures.length === 0
    ? summary
    : `${summary} — ${failures.map((f) => (f.kind === 'failed' ? `${f.stage}: ${f.detail}` : '')).join('; ')}`
}

