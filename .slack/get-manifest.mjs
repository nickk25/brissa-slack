/**
 * The `get-manifest` hook the Slack CLI calls.
 *
 * It prints `manifest.json` and nothing else — the CLI reads stdout as the app
 * manifest, so a stray log line here becomes a parse error with no explanation.
 * Extra flags (`--source=…`) are passed by the CLI and deliberately ignored.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
process.stdout.write(readFileSync(join(import.meta.dirname, '..', 'manifest.json'), 'utf8'))
