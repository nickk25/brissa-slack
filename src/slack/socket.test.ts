import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { test } from 'node:test'
import { connectSocketMode, readFrame, type Socket } from './socket.ts'
import type { Envelope } from './verify.ts'

const eventFrame = (envelopeId = 'Env1', eventId = 'Ev1') =>
  JSON.stringify({
    type: 'events_api',
    envelope_id: envelopeId,
    payload: { type: 'event_callback', event_id: eventId, event: { type: 'message', channel: 'C1', text: 'hallo' } },
  })

test('INV-slack-37 an event frame yields the id to acknowledge and the envelope inside it', async () => {
  const frame = readFrame(eventFrame())
  assert.ok(frame.kind === 'event')
  assert.equal(frame.envelopeId, 'Env1')
  assert.deepEqual(frame.envelope, {
    kind: 'event',
    eventId: 'Ev1',
    event: { type: 'message', channel: 'C1', text: 'hallo' },
    retryNum: 0,
  })
})

test('INV-slack-38 hello and disconnect are recognised, and neither is an error', async () => {
  // Slack closes these connections on its own schedule. Reconnecting is the
  // normal case, not the failure case.
  assert.deepEqual(readFrame('{"type":"hello"}'), { kind: 'hello' })
  assert.deepEqual(readFrame('{"type":"disconnect","reason":"warning"}'), {
    kind: 'disconnect',
    reason: 'warning',
  })
})

test('INV-slack-39 a frame this app has no use for is named rather than mistaken for one', async () => {
  assert.deepEqual(readFrame('{"type":"some_future_thing","envelope_id":"E1"}'), {
    kind: 'other',
    type: 'some_future_thing',
  })
  // An events_api frame with no envelope id cannot be acknowledged, so acting on
  // it would guarantee the redelivery it was meant to prevent.
  assert.deepEqual(readFrame('{"type":"events_api"}'), { kind: 'other', type: 'events_api' })
  for (const junk of ['not json', 'null', '[]', '5']) {
    assert.deepEqual(readFrame(junk), { kind: 'other', type: 'unparseable' }, junk)
  }
})

test('INV-slack-40 the envelope is acknowledged before it is handed on', async () => {
  // Slack redelivers anything it has not heard back about within three seconds,
  // and what happens next is a model call that can take longer than that alone.
  const order: string[] = []
  const listeners = new Map<string, (event: { data: unknown }) => void>()

  const socket: Socket = {
    send: (data) => order.push(`ack:${JSON.parse(data).envelope_id}`),
    close: () => order.push('close'),
    addEventListener: ((type: string, listener: (event: { data: unknown }) => void) => {
      listeners.set(type, listener)
    }) as Socket['addEventListener'],
  }

  const seen: Envelope[] = []
  const connection = connectSocketMode({
    appToken: 'xapp-x',
    open: () => socket,
    fetchImpl: (async () => ({ json: async () => ({ ok: true, url: 'wss://example.test' }) })) as unknown as typeof fetch,
    onEnvelope: (envelope) => {
      order.push('handed on')
      seen.push(envelope)
    },
  })

  // `start` awaits the URL, so let the microtasks that follow it settle.
  await new Promise((r) => setTimeout(r, 0))
  listeners.get('message')?.({ data: eventFrame('Env7') })

  assert.deepEqual(order, ['ack:Env7', 'handed on'])
  assert.equal(seen.length, 1)
  connection.close()
})

test('INV-slack-41 a frame with nothing to act on is acknowledged to nobody', async () => {
  // Acknowledging a frame we did not understand would tell Slack it was handled.
  const sent: string[] = []
  const listeners = new Map<string, (event: { data: unknown }) => void>()
  const socket: Socket = {
    send: (data) => sent.push(data),
    close: () => {},
    addEventListener: ((type: string, listener: (event: { data: unknown }) => void) => {
      listeners.set(type, listener)
    }) as Socket['addEventListener'],
  }

  let handled = 0
  const connection = connectSocketMode({
    appToken: 'xapp-x',
    open: () => socket,
    fetchImpl: (async () => ({ json: async () => ({ ok: true, url: 'wss://example.test' }) })) as unknown as typeof fetch,
    onEnvelope: () => void handled++,
  })

  await new Promise((r) => setTimeout(r, 0))
  listeners.get('message')?.({ data: '{"type":"hello"}' })
  listeners.get('message')?.({ data: '{"type":"slash_commands"}' })

  assert.deepEqual(sent, [])
  assert.equal(handled, 0)
  connection.close()
})

/** A socket whose listeners the test can fire by hand. */
function fakeSocket() {
  const listeners = new Map<string, (event: { data: unknown }) => void>()
  const sent: string[] = []
  let closed = 0
  const socket: Socket = {
    send: (data) => sent.push(data),
    close: () => void closed++,
    addEventListener: ((type: string, listener: (event: { data: unknown }) => void) => {
      listeners.set(type, listener)
    }) as Socket['addEventListener'],
  }
  return { socket, sent, listeners, closed: () => closed }
}

const issuing = (body: unknown): typeof fetch => (async () => ({ json: async () => body })) as unknown as typeof fetch

test('INV-slack-42 a connection that drops on its own is reopened', async () => {
  // Sockets drop for reasons nobody announces: a network blip, a Slack restart.
  // A dropped connection with nothing reopening it is a process that looks
  // alive and receives nothing.
  const first = fakeSocket()
  const second = fakeSocket()
  const opened: string[] = []
  let nth = 0

  const connection = connectSocketMode({
    appToken: 'xapp-x',
    fetchImpl: issuing({ ok: true, url: 'wss://example.test' }),
    open: (url) => {
      opened.push(url)
      return nth++ === 0 ? first.socket : second.socket
    },
    onEnvelope: () => {},
  })

  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(opened, ['wss://example.test'])

  first.listeners.get('close')?.({ data: '' })
  await new Promise((r) => setTimeout(r, 1200))
  assert.deepEqual(opened, ['wss://example.test', 'wss://example.test'])

  connection.close()
})

test('INV-slack-43 closing on purpose stays closed', async () => {
  // The difference between "Slack dropped us" and "we are shutting down". A
  // reconnect loop that ignored the second would keep a process alive forever.
  const s = fakeSocket()
  let opens = 0
  const connection = connectSocketMode({
    appToken: 'xapp-x',
    fetchImpl: issuing({ ok: true, url: 'wss://example.test' }),
    open: () => {
      opens++
      return s.socket
    },
    onEnvelope: () => {},
  })

  await new Promise((r) => setTimeout(r, 0))
  connection.close()
  s.listeners.get('close')?.({ data: '' })
  await new Promise((r) => setTimeout(r, 1200))

  assert.equal(opens, 1)
  assert.ok(s.closed() >= 1)
})

test('INV-slack-44 a connection Slack refuses to open is said out loud and tried again', async () => {
  // A revoked app token fails here, every time, and silence would leave a
  // process that looks alive and receives nothing.
  const said: string[] = []
  let attempts = 0
  const connection = connectSocketMode({
    appToken: 'xapp-revoked',
    fetchImpl: (async () => {
      attempts++
      return { json: async () => ({ ok: false, error: 'invalid_auth' }) }
    }) as unknown as typeof fetch,
    open: () => fakeSocket().socket,
    onStatus: (s) => said.push(s),
    onEnvelope: () => {},
  })

  await new Promise((r) => setTimeout(r, 1200))
  connection.close()

  assert.ok(said.some((s) => s.includes('invalid_auth')))
  assert.ok(said.some((s) => s.includes('reconnecting')))
  assert.ok(attempts >= 2)
})

test('INV-slack-45 arriving connected resets the backoff', async () => {
  // Otherwise a connection that survives an hour and then drops would wait the
  // full thirty seconds, having earned that delay days earlier.
  const said: string[] = []
  const sockets = [fakeSocket(), fakeSocket(), fakeSocket()]
  let nth = 0
  const connection = connectSocketMode({
    appToken: 'xapp-x',
    fetchImpl: issuing({ ok: true, url: 'wss://example.test' }),
    open: () => sockets[nth++]?.socket ?? fakeSocket().socket,
    onStatus: (s) => said.push(s),
    onEnvelope: () => {},
  })

  await new Promise((r) => setTimeout(r, 0))
  sockets[0]?.listeners.get('message')?.({ data: '{"type":"hello"}' })
  sockets[0]?.listeners.get('close')?.({ data: '' })
  await new Promise((r) => setTimeout(r, 1200))

  assert.ok(said.includes('connected'))
  // First wait after a successful connection is the smallest one, not a
  // continuation of whatever came before.
  assert.ok(said.includes('reconnecting in 1000ms'))
  connection.close()
})

test('INV-slack-55 an interaction is acknowledged and handed on unparsed', async () => {
  // This module knows the frame; `shortcut.ts` knows what is inside it. Parsing
  // here would put the shape of a shortcut in the file that reads sockets.
  const order: string[] = []
  const listeners = new Map<string, (event: { data: unknown }) => void>()
  const socket: Socket = {
    send: (data) => order.push(`ack:${JSON.parse(data).envelope_id}`),
    close: () => {},
    addEventListener: ((type: string, listener: (event: { data: unknown }) => void) => {
      listeners.set(type, listener)
    }) as Socket['addEventListener'],
  }

  const seen: unknown[] = []
  const connection = connectSocketMode({
    appToken: 'xapp-x',
    open: () => socket,
    fetchImpl: (async () => ({ json: async () => ({ ok: true, url: 'wss://example.test' }) })) as unknown as typeof fetch,
    onEnvelope: () => order.push('event'),
    onInteractive: (payload) => {
      order.push('handed on')
      seen.push(payload)
    },
  })

  await new Promise((r) => setTimeout(r, 0))
  listeners.get('message')?.({
    data: JSON.stringify({ type: 'interactive', envelope_id: 'Env9', payload: { type: 'message_action' } }),
  })

  assert.deepEqual(order, ['ack:Env9', 'handed on'])
  assert.deepEqual(seen, [{ type: 'message_action' }])
  connection.close()
})

test('INV-slack-67 a slash command is acknowledged and handed on unparsed', async () => {
  // Same discipline as an interaction: this module knows the frame, `command.ts`
  // knows what is inside it, and the ack goes first because Slack redelivers
  // anything it has not heard back about within three seconds.
  const order: string[] = []
  const listeners = new Map<string, (event: { data: unknown }) => void>()
  const socket: Socket = {
    send: (data) => order.push(`ack:${JSON.parse(data).envelope_id}`),
    close: () => {},
    addEventListener: ((type: string, listener: (event: { data: unknown }) => void) => {
      listeners.set(type, listener)
    }) as Socket['addEventListener'],
  }

  const seen: unknown[] = []
  const connection = connectSocketMode({
    appToken: 'xapp-x',
    open: () => socket,
    fetchImpl: (async () => ({ json: async () => ({ ok: true, url: 'wss://example.test' }) })) as unknown as typeof fetch,
    onEnvelope: () => order.push('event'),
    onCommand: (payload) => {
      order.push('handed on')
      seen.push(payload)
    },
  })

  await new Promise((r) => setTimeout(r, 0))
  listeners.get('message')?.({
    data: JSON.stringify({ type: 'slash_commands', envelope_id: 'Env3', payload: { command: '/translate' } }),
  })

  assert.deepEqual(order, ['ack:Env3', 'handed on'])
  assert.deepEqual(seen, [{ command: '/translate' }])
  connection.close()
})

test('INV-slack-70 a connection waiting to reopen keeps the process alive', async () => {
  // This is here because the opposite shipped. The reconnect timer was `unref`ed,
  // so when the socket closed — which Slack does routinely — the only pending
  // work was a timer Node had been told to ignore, and Node exited with status
  // 0. Brissa was off and it looked like a clean shutdown.
  //
  // Asserted by running it: a unit test cannot see whether the event loop is
  // held open, but a child process either is still there or it is not.
  const script = `
    const { connectSocketMode } = await import('${new URL('./socket.ts', import.meta.url).href}')
    let closeIt
    connectSocketMode({
      appToken: 'x',
      fetchImpl: async () => ({ json: async () => ({ ok: true, url: 'wss://example.test' }) }),
      open: () => ({
        send() {}, close() {},
        addEventListener(type, listener) { if (type === 'close') closeIt = listener },
      }),
      onEnvelope: () => {},
    })
    setTimeout(() => { closeIt() }, 50)
  `
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {
    stdio: 'ignore',
  })

  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
  const stillHere = new Promise<'alive'>((resolve) => setTimeout(() => resolve('alive'), 900))

  const outcome = await Promise.race([exited, stillHere])
  child.kill()

  assert.equal(outcome, 'alive', 'the process exited while a reconnect was pending')
})

/** A socket pool for the handover tests: each `open` takes the next fake. */
function pool(count: number) {
  const fakes = Array.from({ length: count }, () => fakeSocket())
  const opened: ReturnType<typeof fakeSocket>[] = []
  const open = () => {
    const next = fakes[opened.length] ?? fakeSocket()
    opened.push(next)
    return next.socket
  }
  return { fakes, opened, open }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

test('INV-slack-102 when Slack renews the connection, the replacement opens before the old one is let go', async () => {
  // Slack renews connections on its own schedule, sending `warning` and then
  // `refresh_requested`, and closes the old connection itself. Closing first
  // and reopening once the close completed left a window with no connection —
  // ten seconds in production, in which a slash command got Slack's "the app
  // did not respond". Slack allows up to ten connections and recommends opening
  // the extra one before the restart.
  const p = pool(2)
  const [old, replacement] = p.fakes
  const connection = connectSocketMode({
    appToken: 'xapp-x',
    fetchImpl: issuing({ ok: true, url: 'wss://example.test' }),
    open: p.open,
    retireAfterMs: 50,
    onEnvelope: () => {},
  })

  await tick()
  old?.listeners.get('message')?.({ data: '{"type":"hello"}' })
  old?.listeners.get('message')?.({ data: '{"type":"disconnect","reason":"warning"}' })
  await tick()
  assert.equal(p.opened.length, 2, 'the replacement opens at once, with no backoff')

  replacement?.listeners.get('message')?.({ data: '{"type":"hello"}' })
  // Left for Slack to close: closing it here could drop a payload already
  // routed to it while the close handshake runs.
  assert.equal(old?.closed(), 0, 'the old connection is not closed the moment the replacement is live')

  // Safety net, for an old connection Slack never closes.
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(old?.closed(), 1, 'and is closed later if Slack has not done it')

  // Its close is the handover finishing, so it schedules nothing.
  old?.listeners.get('close')?.({ data: '' })
  await new Promise((r) => setTimeout(r, 1200))
  assert.equal(p.opened.length, 2)
  connection.close()
})

test('INV-slack-103 a second renewal notice on a connection already being replaced opens nothing more', async () => {
  // Slack's sequence on one connection is `warning`, then `refresh_requested`
  // about ten seconds later. If the replacement has not said hello by then, a
  // second replacement would open and be tracked by nothing — never closed on
  // shutdown, holding the process open.
  const p = pool(3)
  const [old] = p.fakes
  const connection = connectSocketMode({
    appToken: 'xapp-x',
    fetchImpl: issuing({ ok: true, url: 'wss://example.test' }),
    open: p.open,
    onEnvelope: () => {},
  })

  await tick()
  old?.listeners.get('message')?.({ data: '{"type":"disconnect","reason":"warning"}' })
  await tick()
  old?.listeners.get('message')?.({ data: '{"type":"disconnect","reason":"refresh_requested"}' })
  await tick()
  assert.equal(p.opened.length, 2, 'one replacement, not two')

  // And shutting down closes every connection that was opened.
  connection.close()
  for (const f of p.opened) assert.ok(f.closed() >= 1, 'no connection outlives close()')
})

test('INV-slack-104 a replaced connection that closes before its replacement is open schedules no second connection', async () => {
  // The case that needs the guard: Slack closes the old connection while the
  // replacement's URL is still being issued. Without it, the close would start
  // a reconnect on top of the open already in flight.
  let release: (v: unknown) => void = () => {}
  const said: string[] = []
  const p = pool(3)
  const [old] = p.fakes
  let calls = 0
  const connection = connectSocketMode({
    appToken: 'xapp-x',
    fetchImpl: (async () => {
      calls++
      if (calls === 1) return { json: async () => ({ ok: true, url: 'wss://example.test' }) }
      await new Promise((r) => { release = r })
      return { json: async () => ({ ok: true, url: 'wss://example.test' }) }
    }) as unknown as typeof fetch,
    open: p.open,
    onStatus: (status) => said.push(status),
    onEnvelope: () => {},
  })

  await tick()
  old?.listeners.get('message')?.({ data: '{"type":"disconnect","reason":"refresh_requested"}' })
  await tick()
  old?.listeners.get('close')?.({ data: '' })
  assert.ok(!said.some((s) => s.startsWith('reconnecting')), 'the old close must not start a reconnect')

  release(undefined)
  await tick()
  await tick()
  assert.equal(p.opened.length, 2, 'exactly the one replacement')
  connection.close()

  // Closing on purpose while a URL is still being issued opens nothing after.
  let releaseLate: (v: unknown) => void = () => {}
  let lateOpens = 0
  const late = connectSocketMode({
    appToken: 'xapp-x',
    fetchImpl: (async () => {
      await new Promise((r) => { releaseLate = r })
      return { json: async () => ({ ok: true, url: 'wss://example.test' }) }
    }) as unknown as typeof fetch,
    open: () => { lateOpens++; return fakeSocket().socket },
    onEnvelope: () => {},
  })
  late.close()
  releaseLate(undefined)
  await tick()
  await tick()
  assert.equal(lateOpens, 0)
})

test('INV-slack-105 a disconnect that is not a scheduled renewal closes and backs off', async () => {
  // `link_disabled` means Socket Mode was switched off, and a reason this does
  // not know is not a renewal either. Opening a replacement at once there could
  // loop at API speed; closing and reconnecting with backoff cannot.
  const said: string[] = []
  const p = pool(3)
  const [old] = p.fakes
  const connection = connectSocketMode({
    appToken: 'xapp-x',
    fetchImpl: issuing({ ok: true, url: 'wss://example.test' }),
    open: p.open,
    onStatus: (status) => said.push(status),
    onEnvelope: () => {},
  })

  await tick()
  old?.listeners.get('message')?.({ data: '{"type":"disconnect","reason":"link_disabled"}' })
  await tick()
  assert.equal(p.opened.length, 1, 'no replacement opened at once')
  assert.equal(old?.closed(), 1)

  old?.listeners.get('close')?.({ data: '' })
  assert.ok(said.some((s) => s.startsWith('reconnecting in')), 'it reconnects through the backoff')
  connection.close()
})
