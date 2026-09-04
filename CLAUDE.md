# Brissa — map for agents

Slack without the language barrier. Nobody reads this code end to end; agents
write it and agents maintain it. This file exists to route you to the right file
in as few reads as possible, and is capped at 160 lines.

## 0. The gates are enforced

`main` is protected with an empty bypass list. Nobody writes to it outside a pull
request whose checks passed — not you, not the owner, not CI. A push straight to
`main` is refused by the server.

Two habits the machine cannot enforce for you:

- **Report what the checks said**, verbatim, at the end of any session that
  touched code, including failures you did not fix and why.
- **Never route around a rule.** Renaming a file out of a pattern, or splitting a
  change so neither half fires it, still works and is still worse than the bug
  the rule existed to catch. If a rule is wrong, change the rule in its own pull
  request and say why.

## 1. Session protocol

1. Read this file, then the contract of the module you are about to touch.
2. `npm run gate:plan -- <the files you intend to touch>` **before writing**.
3. Change one module. Needing two usually means a boundary is wrong — say so
   rather than working around it.
4. Regenerate what is generated; write the prose that changed.
5. `npm run verify`. Report the result, pass or fail.
6. Open the pull request and ask for auto-merge in the same breath:
   `gh pr create ... && gh pr merge --auto --squash`.

## 2. What Brissa is

A Slack app that translates the messages you cannot read, privately, in place.

The product is not the translation — that is a commodity. The product is the
restraint: it stays silent unless a message contains language you do not read,
and when it speaks, only you see it.

Two decisions everything else follows from:

- **Detect by sentence, translate the whole message.** A detector that reads a
  message as one language misses `Hi all.` followed by four paragraphs of German,
  which is exactly the shape a real Slack message takes. But translating only the
  foreign fragments leaves you stitching a message back together in your head,
  which is the work we are removing.
- **Silence is the feature.** If everyone in a channel shares a language, Brissa
  does not exist. The messages you cannot read are not a random sample — people
  write in a second language until something matters, then revert to their own.

## 3. Map

| Path | What lives there |
| --- | --- |
| `src/core/` | All the logic. Pure: no I/O, no SDK, no clock, no randomness. |
| `src/llm/` | The only module that imports the Anthropic SDK. |
| `src/slack/` | The only module that imports the Slack SDK. |
| `src/store/` | Who reads what, and what Brissa may do in a channel. No database yet. |
| `src/app/` | Wiring. The only module allowed to import all the others. |
| `fixtures/corpus/` | Real messages and the decision each should produce. Protected. |
| `coupling.yaml` | This repository's rules. Also the schema reference. |
| `tools/agentic/` | The gate, contracts, invariants and state machinery. Protected. |

## 4. I want to change X, so I read Y

| Intent | Read first |
| --- | --- |
| Change what gets translated | `src/core/`, then the corpus — the corpus is the spec |
| Change the prompt | `src/llm/prompts/`, and be ready to run the eval |
| Change how Slack is read or written | `src/slack/` only; nothing else may import its SDK |
| Add a rule | `coupling.yaml` — protected, needs a label |
| Understand the scaffolding | `tools/agentic/` and its own docs |

## 5. Rules of this repository

Generated from `coupling.yaml`. Do not edit by hand.

<!-- gen:coupling -->
| Rule | Fires when you touch | It will demand |
| --- | --- | --- |
| `module-contract` | `src/{module}/**` | `npm run contracts:check` to pass; a change in `src/{module}/CLAUDE.md` |
| `invariants-anchored` | `src/**`, `**/CLAUDE.md` | `npm run invariants` to pass |
| `corpus-is-evidence` | `fixtures/corpus/**` | the `human-approved` label |
| `prompt-evaluated` | `src/llm/prompts/**` | `npm run eval:check` to pass |
| `protected-controls` | `coupling.yaml`, `.github/workflows/**`, `tools/agentic/**` | the `human-approved` label |
<!-- /gen:coupling -->

## 6. Commands

Generated from `package.json`. Do not edit by hand.

<!-- gen:commands -->
| Command | Runs |
| --- | --- |
| `npm run calibrate` | `node --env-file-if-exists=.env tools/eval/calibrate.mjs` |
| `npm run contracts` | `node tools/agentic/contracts.mjs` |
| `npm run contracts:check` | `node tools/agentic/contracts.mjs --check` |
| `npm run eval:check` | `node tools/eval/contamination.mjs && node tools/eval/check.mjs` |
| `npm run eval:contamination` | `node tools/eval/contamination.mjs` |
| `npm run gate` | `node tools/agentic/gate.mjs` |
| `npm run gate:plan` | `node tools/agentic/gate.mjs --plan` |
| `npm run invariants` | `node tools/agentic/invariants.mjs` |
| `npm run state` | `node tools/agentic/state.mjs` |
| `npm run state:snapshot` | `node tools/agentic/state.mjs snapshot` |
| `npm run test` | `node --test 'tools/agentic/**/*.test.mjs' && node --experimental-strip-types --test 'src/**/*.test.ts'` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run verify` | `npm run typecheck && npm run contracts:check && npm run invariants && npm test && npm run gate` |
<!-- /gen:commands -->

## 7. Invariants

Each bullet is anchored to a test whose title begins with its id. `npm run
invariants` enforces the mapping in both directions: a claim with no test is a
claim nobody checks, and a test carrying an id no contract declares is a rule the
next agent deletes without knowing it existed.

This proves an invariant is covered, never that its test is any good. Mutation
testing is what closes that.

<!-- placeholder: the first invariant lands with the first module -->

## 8. Never

- Silence the checker: no `any`, `as unknown as`, `@ts-ignore`, `@ts-expect-error`
  or `eslint-disable`.
- Weaken an expectation, or edit the corpus, so that code passes. Fix the code.
- Let logic leak into an adapter. `src/slack/` filling with `if`s about message
  content is the failure mode to watch for — the data is there, so the logic
  drifts there.
- Translate what must not be translated: code blocks, links, `@mentions`, emoji,
  product names, numbers and dates.
- Swallow an error. If Brissa cannot translate, that has to be visible.
- Add `utils`, `common` or `shared` folders. They are where every boundary leaks.
- Review your own work as the only reviewer.
