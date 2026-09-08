import assert from 'node:assert/strict'
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
  assert.deepEqual(readFrame('{"type":"slash_commands","envelope_id":"E1"}'), {
    kind: 'other',
    type: 'slash_commands',
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

test('INV-slack-42 a closed connection is reopened, because Slack closes them routinely', async () => {
  // Slack sends `disconnect` before its own deploys. Treating that as a failure
  // would mean Brissa stops working every time Slack ships.
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

  // Slack asks us to go away; we close, which triggers the reopen.
  first.listeners.get('message')?.({ data: '{"type":"disconnect","reason":"link_disabled"}' })
  assert.equal(first.closed(), 1)

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
