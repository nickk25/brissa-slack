/**
 * Socket Mode: Slack's other way of delivering the same envelopes.
 *
 * The machine running this opens a websocket **outward** to Slack, and Slack
 * pushes events down it. No public URL, no tunnel, no deployment — which is the
 * only reason anything here can be run before anything has been deployed.
 *
 * The security model is different and worth stating, because it looks like a
 * check is missing. Over HTTP, Slack signs each request and `verify.ts` proves
 * it. Over a websocket, **the connection itself is the proof**: it was opened
 * with an app-level token against a URL Slack issued for this app alone, and
 * nothing else can write to it. There is no signature on these frames and none
 * is expected.
 *
 * What does not change is the ack. Slack redelivers an envelope it was not
 * acknowledged for within three seconds, exactly as it redelivers an HTTP
 * request — so the acknowledgement goes out before the work starts, and
 * deduplication catches whatever slips through.
 */

import { readEnvelope, type Envelope } from './verify.ts'

/**
 * The frames this reads, out of the several Slack sends.
 *
 * Declared here rather than imported for the same reason `SlackMessageEvent` is:
 * a small visible surface beats a large invisible one.
 */
export type Frame =
  /** Sent once when the connection is live. */
  | { readonly kind: 'hello' }
  /** An event, with the id that must be echoed back to acknowledge it. */
  | { readonly kind: 'event'; readonly envelopeId: string; readonly envelope: Envelope }
  /**
   * Somebody clicked something. The payload is left unparsed on purpose — this
   * module knows the frame, `shortcut.ts` knows what is inside it, and mixing
   * the two would put the shape of a shortcut in the file that reads sockets.
   */
  | { readonly kind: 'interactive'; readonly envelopeId: string; readonly payload: unknown }
  /** Somebody typed a slash command. Payload left unparsed, same as above. */
  | { readonly kind: 'command'; readonly envelopeId: string; readonly payload: unknown }
  /** Slack asking for the connection to be re-established. Routine, not an error. */
  | { readonly kind: 'disconnect'; readonly reason: string }
  | { readonly kind: 'other'; readonly type: string }

interface RawFrame {
  readonly type?: string
  readonly envelope_id?: string
  readonly reason?: string
  readonly payload?: unknown
  readonly retry_attempt?: number
}

/**
 * One frame, read without any I/O, so every decision here is testable.
 *
 * The payload is re-serialised before going through `readEnvelope` because that
 * function's contract is a string — it is the same function the HTTP path uses,
 * and giving the two paths one parser is what keeps them from disagreeing about
 * what an envelope is.
 */
export function readFrame(raw: string): Frame {
  let frame: RawFrame
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { kind: 'other', type: 'unparseable' }
    }
    frame = parsed as RawFrame
  } catch {
    return { kind: 'other', type: 'unparseable' }
  }

  if (frame.type === 'hello') return { kind: 'hello' }
  if (frame.type === 'disconnect') return { kind: 'disconnect', reason: frame.reason ?? 'unknown' }

  if (frame.type === 'slash_commands' && typeof frame.envelope_id === 'string') {
    return { kind: 'command', envelopeId: frame.envelope_id, payload: frame.payload ?? null }
  }

  if (frame.type === 'interactive' && typeof frame.envelope_id === 'string') {
    return { kind: 'interactive', envelopeId: frame.envelope_id, payload: frame.payload ?? null }
  }

  if (frame.type === 'events_api' && typeof frame.envelope_id === 'string') {
    return {
      kind: 'event',
      envelopeId: frame.envelope_id,
      envelope: readEnvelope(JSON.stringify(frame.payload ?? null)),
    }
  }

  return { kind: 'other', type: frame.type ?? 'unknown' }
}

/** The subset of a websocket this uses, so a test needs no server. */
export interface Socket {
  send(data: string): void
  close(): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  addEventListener(type: 'close' | 'error', listener: () => void): void
}

export interface SocketModeOptions {
  readonly appToken: string
  /**
   * Called once per event, **after** it has been acknowledged.
   *
   * Returning a promise is fine and it is not awaited before the ack, which is
   * the entire point.
   */
  readonly onEnvelope: (envelope: Envelope) => void
  /** Called once per interaction, also after the acknowledgement. */
  readonly onInteractive?: (payload: unknown) => void
  /** Called once per slash command, also after the acknowledgement. */
  readonly onCommand?: (payload: unknown) => void
  /** Connection lifecycle, for whoever wants to say something about it. */
  readonly onStatus?: (status: string) => void
  /** Injected so a test can open a fake socket and drive it by hand. */
  readonly open?: (url: string) => Socket
  readonly fetchImpl?: typeof fetch
}

/** What Slack gives back in exchange for an app-level token. */
async function issueUrl(appToken: string, fetchImpl: typeof fetch): Promise<string> {
  const response = await fetchImpl('https://slack.com/api/apps.connections.open', {
    method: 'POST',
    headers: { authorization: `Bearer ${appToken}` },
  })
  const body = (await response.json()) as { ok?: boolean; url?: string; error?: string }
  if (body.ok !== true || !body.url) throw new Error(`apps.connections.open: ${body.error ?? 'no url'}`)
  return body.url
}

export interface Connection {
  close(): void
}

/**
 * Connect, and keep connecting.
 *
 * Slack closes these on its own schedule — a `disconnect` frame before a
 * deploy on their side, or simply a socket that drops — so reconnecting is the
 * normal case rather than the error case. The backoff exists for the abnormal
 * one: an app token that has been revoked would otherwise reconnect in a tight
 * loop forever.
 */
export function connectSocketMode(options: SocketModeOptions): Connection {
  const fetchImpl = options.fetchImpl ?? fetch
  const open = options.open ?? ((url: string) => new WebSocket(url) as unknown as Socket)
  const say = options.onStatus ?? (() => {})

  let stopped = false
  let socket: Socket | undefined
  let attempt = 0

  const reconnect = () => {
    if (stopped) return
    attempt += 1
    const wait = Math.min(2 ** attempt * 500, 30_000)
    say(`reconnecting in ${wait}ms`)
    setTimeout(() => void start(), wait).unref?.()
  }

  async function start(): Promise<void> {
    if (stopped) return
    let url: string
    try {
      url = await issueUrl(options.appToken, fetchImpl)
    } catch (err) {
      say(`could not open a connection: ${String((err as Error)?.message ?? err)}`)
      reconnect()
      return
    }

    const ws = open(url)
    socket = ws

    ws.addEventListener('message', (event) => {
      const frame = readFrame(String(event.data))

      if (frame.kind === 'hello') {
        attempt = 0
        say('connected')
        return
      }
      if (frame.kind === 'disconnect') {
        say(`Slack asked us to reconnect (${frame.reason})`)
        ws.close()
        return
      }
      if (frame.kind !== 'event' && frame.kind !== 'interactive' && frame.kind !== 'command') return

      // Acknowledged first, always. Slack redelivers anything it has not heard
      // back about within three seconds, and the work below can take longer than
      // that on its own.
      ws.send(JSON.stringify({ envelope_id: frame.envelopeId }))

      if (frame.kind === 'event') options.onEnvelope(frame.envelope)
      else if (frame.kind === 'interactive') options.onInteractive?.(frame.payload)
      else options.onCommand?.(frame.payload)
    })

    ws.addEventListener('close', () => {
      if (socket === ws) reconnect()
    })
    ws.addEventListener('error', () => {
      say('socket error')
    })
  }

  void start()

  return {
    close() {
      stopped = true
      socket?.close()
      socket = undefined
    },
  }
}
