/**
 * The one place Brissa listens on a port at all.
 *
 * Socket Mode opens a websocket **outward** to Slack (`src/slack/socket.ts`),
 * so until now nothing here has ever needed to accept an inbound connection.
 * Per-user OAuth changes that: Slack has to redirect a *browser* back to a URL
 * Brissa owns, and a redirect only works if something is listening for it.
 *
 * This file is the transport, and nothing else. It knows there are three
 * paths and what HTTP status each one gets; it does not know what an OAuth
 * exchange is, what a token looks like, or how `state` is signed. Those
 * decisions belong to whatever `Routes` this is built with — a module this
 * file is not allowed to import, the same way `http.ts` never imports
 * `src/llm` even though a translation happens because of what it does.
 *
 * **A browser is the client here, not Slack.** Every other edge in `src/app`
 * answers a machine that retries on anything but 2xx; this one answers a
 * person sitting in a tab, mid-installation, who cannot retry their way past
 * a mistake. `/oauth/callback`'s body is always plain, readable text — never
 * JSON, never a stack trace — and a failure says what to do next rather than
 * what broke.
 *
 * **Nothing token-shaped leaves this file.** `code` and `state` arrive as
 * query parameters, which means they are already sitting in the browser's
 * history and in every proxy log between here and Slack before this code
 * ever runs. This file does not make that better, but it refuses to make it
 * worse: it never logs the request URL or its query, and a `callback` that
 * throws is answered with one fixed, generic message rather than the error's
 * own text — an exception can quote the very value this is trying not to
 * repeat.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

/** What Slack put on the query string of the redirect back to us. */
export type CallbackQuery = Readonly<Record<string, string | undefined>>

/**
 * The behaviour this transport is built with, injected so `server.ts` stays
 * testable with no network and no Slack.
 *
 * Deliberately narrow: `start` returns only a place to redirect to, and
 * `callback` only a status and a body. Neither shape leaves room for this
 * file to learn what either one means.
 */
export interface Routes {
  /**
   * Where to send the browser to begin Slack's authorize step.
   *
   * Synchronous on purpose — building the authorize URL is composing a
   * string, not reaching a network or a store, and `/oauth/start` should
   * never be able to hang on it.
   */
  start(): { readonly location: string }

  /** What to tell the browser once Slack has sent it back with a result. */
  callback(query: CallbackQuery): Promise<{ readonly status: number; readonly body: string }>
}

const TEXT = { 'content-type': 'text/plain; charset=utf-8' } as const

/**
 * What a person sees if `callback` throws instead of returning.
 *
 * Fixed and generic on purpose: an exception's own message is exactly the
 * kind of place a `code` or a `state` value ends up by accident, and this is
 * the one response in this file that a module this file does not own cannot
 * shape by returning something careless.
 */
const CALLBACK_FAILED =
  'Something went wrong finishing this connection. Close this tab and try connecting again from Slack.'

const NOT_FOUND = 'not found'

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, TEXT)
  res.end(body)
}

/** `URLSearchParams` flattened to the shape `Routes.callback` is given. */
function queryOf(params: URLSearchParams): CallbackQuery {
  const query: Record<string, string | undefined> = {}
  for (const key of params.keys()) query[key] = params.get(key) ?? undefined
  return query
}

async function respond(routes: Routes, req: IncomingMessage, res: ServerResponse): Promise<void> {
  // A base is required to parse a path-only `req.url`; it is never used for
  // anything but reading `pathname` and `searchParams` back off, so what it
  // says does not matter.
  const url = new URL(req.url ?? '/', 'http://internal')
  const method = req.method ?? 'GET'

  // Exactly three routes, each GET-only. Everything else — a path this app
  // does not own, or the right path with the wrong method — gets the same
  // 404 below, and the same body: unknown paths say nothing about what does
  // exist, which is as true of "wrong verb" as it is of "wrong path".
  if (method === 'GET' && url.pathname === '/healthz') {
    // Answers on its own, calling neither port. A health check that awaits
    // `start` or `callback` is a health check that lies about a different
    // thing the moment either one is slow.
    return send(res, 200, 'ok')
  }

  if (method === 'GET' && url.pathname === '/oauth/start') {
    const { location } = routes.start()
    res.writeHead(302, { ...TEXT, location })
    res.end('Redirecting to Slack…')
    return
  }

  if (method === 'GET' && url.pathname === '/oauth/callback') {
    try {
      const result = await routes.callback(queryOf(url.searchParams))
      return send(res, result.status, result.body)
    } catch {
      return send(res, 500, CALLBACK_FAILED)
    }
  }

  return send(res, 404, NOT_FOUND)
}

export interface RunningServer {
  readonly port: number
  /** Resolves once the port is free. Awaiting it is what keeps a test from
   * leaking a listening socket into the next one. */
  close(): Promise<void>
}

/**
 * Start listening.
 *
 * Returns a promise rather than the server itself because the caller needs
 * the port that was actually bound — `port: 0` (what every test in
 * `server.test.ts` passes) asks the OS for a free one, and it is only known
 * once `listening` fires.
 *
 * Unlike the reconnect timer in `src/slack/socket.ts` — deliberately left
 * holding the event loop open so a dropped connection cannot look like a
 * clean exit — a listening `http.Server` already holds the loop open on its
 * own, which is exactly what is wanted here too: this process is meant to sit
 * on this port for as long as it runs, per `fly.toml`'s
 * `min_machines_running`. The lesson this file draws from that comment is the
 * opposite-facing one: closing has to be provably complete, or a test (and,
 * one day, a redeploy) leaks a socket the way a stray timer once leaked a
 * process. `close()` calls `closeAllConnections()` before `close()`'s own
 * callback, so a keep-alive connection nobody ended explicitly cannot hold
 * the port open past the moment this resolves.
 */
export function startServer(routes: Routes, port: number): Promise<RunningServer> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      void respond(routes, req, res)
    })

    server.once('error', reject)
    server.listen(port, () => {
      server.removeListener('error', reject)
      const address = server.address()
      const bound = typeof address === 'object' && address !== null ? address.port : port

      resolve({
        port: bound,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()))
            server.closeAllConnections()
          }),
      })
    })
  })
}
