/**
 * Deliveries already handled, remembered for as long as a retry can arrive.
 *
 * Slack gives up retrying after a few minutes, so this needs to remember
 * recently, not forever — and it must be bounded, because the alternative is a
 * process whose memory grows with every message the workspace has ever sent and
 * which is fine right up until it is not.
 *
 * Insertion order is the eviction order. That is not an LRU and does not pretend
 * to be: an id offered twice is a duplicate, not a use, so nothing here is ever
 * "touched" a second time in a way that should keep it alive longer.
 */

import type { Seen } from '../core/seen.ts'

/**
 * Ten thousand ids is minutes of traffic for any workspace this will see before
 * there is a shared store, and a few hundred kilobytes.
 */
const DEFAULT_CAPACITY = 10_000

export function createMemorySeen(capacity: number = DEFAULT_CAPACITY): Seen {
  const ids = new Set<string>()

  return {
    async firstTime(id: string): Promise<boolean> {
      if (ids.has(id)) return false

      ids.add(id)

      // Evicting the oldest is what makes this bounded, and it is also the one
      // way this can be wrong: an id evicted while its retry is still coming
      // would be treated as new. That is a capacity question, not a correctness
      // one — the bound has to be larger than the retry window, and it is.
      if (ids.size > capacity) {
        const oldest = ids.values().next()
        // The guard is the type system's, not the logic's: an id was just added,
        // so the iterator cannot be done. It survives mutation testing for that
        // reason — there is no state in which removing it changes anything.
        if (!oldest.done) ids.delete(oldest.value)
      }

      return true
    },
  }
}
