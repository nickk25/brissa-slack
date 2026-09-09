# syntax=docker/dockerfile:1
#
# Brissa has no build step, and this file deliberately doesn't add one.
# `package.json`'s `start` script is
#   node --experimental-strip-types --env-file-if-exists=.env src/app/main.ts
# TypeScript is stripped at *run* time, not compiled. `npm run typecheck`
# (`tsc --noEmit`) is a type gate that runs in CI — it never emits anything —
# so there is no `dist/` to build here and no reason to run `tsc` in this
# image. If a future agent is tempted to add `RUN npm run typecheck` or a
# compile step to this Dockerfile: don't. It would produce a second,
# unstripped copy of the source that this repository's own tests never
# exercise, and it would drift from what actually ships the moment someone
# forgot to rerun it. See docs/DECISIONS.md ("Dependencies" / `typescript`).
#
# Node 22 because `--experimental-strip-types` needs it (stable-enough since
# 22.6) and `package.json`'s `engines.node` already says ">=22".
FROM node:22-alpine

WORKDIR /app

# Dependencies in their own layer so editing src/ doesn't bust the npm cache.
# --omit=dev: no typescript, no stryker — this image only ever runs stripped
# source, never compiles or mutates it.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# The source tree itself. This IS what runs — there is nothing to copy after
# it. src/llm/decide.ts reads its prompt from disk at
# src/llm/prompts/decide.md relative to process.cwd(), which is why the whole
# tree comes along rather than a hand-picked subset.
COPY src ./src

# Non-root. The official node image already ships a `node` user (uid 1000)
# for exactly this; no need to create one.
RUN chown -R node:node /app
USER node

ENV NODE_ENV=production

# No EXPOSE, which is a smaller claim than it used to be. Brissa still opens
# its websocket *outward* to Slack (Socket Mode, see src/slack/socket.ts), but
# per-user OAuth means Slack now redirects a browser back to a URL this app
# owns, so src/app/server.ts genuinely listens on a port — fly.toml names it,
# and the health check at /healthz reaches it. EXPOSE is left out because it
# documents rather than publishes: fly.toml's internal_port is what actually
# decides. See docs/DEPLOY.md for how to tell that it is up.
CMD ["npm", "start"]
