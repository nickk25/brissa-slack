import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import type { ChannelPolicy, Reader } from '../core/ports.ts'
import type { TranslationResult, Translator } from '../core/translator.ts'
import type { EphemeralRequest, SlackApi } from '../slack/send.ts'
import { createMemoryDirectory } from '../store/memory.ts'
import { createMemorySeen } from '../store/seen.ts'
import type { MessageOutcome } from './handle.ts'
import { handleRequest, type Edge } from './http.ts'

const SECRET = 'a-signing-secret'
const NOW = 1_700_000_000_000
const nick: Reader = { userId: 'U-nick', reads: ['es', 'en'] }
const on: ChannelPolicy = { channelId: 'C1', enabled: true }

const envelope = (eventId = 'Ev1') =>
  JSON.stringify({
    type: 'event_callback',
    event_id: eventId,
    event: { type: 'message', channel: 'C1', user: 'U-jens', text: 'Passt bei mir auch!', ts: '1.1' },
  })

/** A request signed the way Slack signs one. */
const signed = (body: string, at = NOW) => {
  const ts = String(at / 1000)
  return {
    body,
    headers: {
      'x-slack-signature': `v0=${createHmac('sha256', SECRET).update(`v0:${ts}:${body}`).digest('hex')}`,
      'x-slack-request-timestamp': ts,
    },
  }
}

function fakes(reply: (r: { text: string }) => Promise<TranslationResult> = async () => ({ kind: 'silent' })) {
  const calls: string[] = []
  const posts: EphemeralRequest[] = []
  const translator: Translator = {
    async translate(request) {
      calls.push(request.text)
      return reply(request)
    },
  }
  const slack: SlackApi = {
    async postEphemeral(request) {
      posts.push(request)
      return { ok: true }
    },
  }
  return { calls, posts, translator, slack }
}

const edge = (f: ReturnType<typeof fakes>, over: Partial<Edge> = {}): Edge => ({
  ports: {
    directory: createMemoryDirectory({ readers: [nick], channels: [on] }),
    translator: f.translator,
    slack: f.slack,
  },
  signingSecret: SECRET,
  seen: createMemorySeen(),
  now: () => NOW,
  report: () => {},
  ...over,
})

test('INV-app-24 Slack is answered while the translation is still running', async () => {
  // The reason this file exists. Slack redelivers if it does not hear back in
  // about three seconds, and a model call with retries can take longer than that
  // on its own — so waiting for the translation before answering would
  // guarantee a duplicate exactly when everything is already slow.
  //
  // Asserted as an order rather than as a flag. A flag that is only ever set
  // later cannot be true at the moment it is checked, whatever the code does; a
  // recorded sequence fails loudly, and without hanging, if the answer moves.
  const order: string[] = []
  const f = fakes(async () => {
    order.push('translating')
    await new Promise((r) => setTimeout(r, 20))
    order.push('translated')
    return { kind: 'silent' }
  })

  const response = await handleRequest(edge(f), signed(envelope()))
  order.push('answered')

  assert.equal(response.status, 200)
  assert.equal(response.body, 'ok')
  assert.deepEqual(order, ['translating', 'answered'])

  await response.done
  assert.deepEqual(order, ['translating', 'answered', 'translated'])
})

test('INV-app-25 a request Slack did not sign reaches nothing at all', async () => {
  // Everything downstream — the model call, somebody's channel — happens because
  // this said yes. A test that only checked the status code would pass while the
  // work ran anyway.
  const f = fakes()
  const unsigned = { body: envelope(), headers: {} }
  const forged = { body: envelope(), headers: signed(envelope(), NOW).headers, extra: 0 }

  const a = await handleRequest(edge(f), unsigned)
  assert.equal(a.status, 401)
  assert.equal(a.body, 'no-signature')

  // Signed correctly, but for a different body than the one that arrived.
  const b = await handleRequest(edge(f), { body: envelope('Ev-other'), headers: forged.headers })
  assert.equal(b.status, 401)
  assert.equal(b.body, 'bad-signature')

  await Promise.all([a.done, b.done])
  assert.deepEqual(f.calls, [])
  assert.deepEqual(f.posts, [])
})

test('INV-app-26 a request too old to trust is refused, however well signed', async () => {
  const f = fakes()
  const stale = signed(envelope(), NOW - 10 * 60 * 1000)
  const response = await handleRequest(edge(f), stale)

  assert.equal(response.status, 401)
  assert.equal(response.body, 'too-old')
  await response.done
  assert.deepEqual(f.calls, [])
})

test('INV-app-27 the setup handshake is answered with the challenge and nothing else', async () => {
  // Sent once, when the endpoint URL is first saved. Failing it means the app
  // can never be installed.
  const f = fakes()
  const body = JSON.stringify({ type: 'url_verification', challenge: 'abc123' })
  const response = await handleRequest(edge(f), signed(body))

  assert.equal(response.status, 200)
  assert.equal(response.body, 'abc123')
  await response.done
  assert.deepEqual(f.calls, [])
})

test('INV-app-28 an envelope we cannot use is not answered with success', async () => {
  // A 200 tells Slack the delivery was handled. Saying that about a request we
  // could not read would absorb a real problem into silence.
  const f = fakes()
  const response = await handleRequest(edge(f), signed('{"type":"event_callback","event":{}}'))

  assert.equal(response.status, 400)
  assert.equal(response.body, 'no-event-id')
  await response.done
  assert.deepEqual(f.calls, [])
})

test('INV-app-29 a redelivery does the work once and is still answered with success', async () => {
  // Slack retries when it did not hear back, which is not an error — reporting
  // one would only produce another retry. `chat.postEphemeral` has no idea it
  // has posted before, so this is the only thing between a bad minute and every
  // reader getting the same translation three times.
  const f = fakes(async () => ({ kind: 'translated', translation: { text: 'Vale.', foundLanguages: ['de'] } }))
  const e = edge(f)

  const first = await handleRequest(e, signed(envelope('Ev-same')))
  await first.done
  const again = await handleRequest(e, signed(envelope('Ev-same')))
  await again.done

  assert.equal(first.body, 'ok')
  assert.equal(again.status, 200)
  assert.equal(again.body, 'duplicate')
  assert.equal(f.calls.length, 1)
  assert.equal(f.posts.length, 1)

  // A different delivery of a different message is not a duplicate of it.
  const other = await handleRequest(e, signed(envelope('Ev-other')))
  await other.done
  assert.equal(f.calls.length, 2)
})

test('INV-app-30 what happened is reported once the work is done, not when it was answered', async () => {
  const f = fakes()
  const seen: MessageOutcome[] = []
  const response = await handleRequest(edge(f, { report: (o) => void seen.push(o) }), signed(envelope()))

  assert.deepEqual(seen, [])
  await response.done
  assert.deepEqual(seen, [
    { kind: 'considered', readers: [{ userId: 'U-nick', kind: 'silent' }] },
  ])
})

test('INV-app-31 a reporter that throws does not take the process down after the fact', async () => {
  // `done` resolves long after the request that produced it was answered, so an
  // unhandled rejection here would surface with nothing to attach it to.
  const f = fakes()
  const response = await handleRequest(
    edge(f, {
      report: () => {
        throw new Error('the logger is down')
      },
    }),
    signed(envelope()),
  )

  assert.equal(response.status, 200)
  await response.done
})

test('INV-app-32 with no clock injected it uses the real one', async () => {
  // Every other test here hands the edge a fixed `now`, which means none of them
  // exercises the branch production actually runs on. A signature check against
  // the wrong clock refuses everything, and it would refuse it identically in
  // every test that supplies its own.
  const f = fakes()
  const at = Date.now()
  const response = await handleRequest(
    {
      ports: {
        directory: createMemoryDirectory({ readers: [nick], channels: [on] }),
        translator: f.translator,
        slack: f.slack,
      },
      signingSecret: SECRET,
      seen: createMemorySeen(),
      report: () => {},
    },
    signed(envelope(), at),
  )

  assert.equal(response.status, 200)
  await response.done
  assert.deepEqual(f.calls, ['Passt bei mir auch!'])
})

test('INV-app-33 an unsigned request never reaches the record of what was already seen', async () => {
  // The poisoning case. If the deduplication ran before the signature check, an
  // attacker who could guess an event id would silence the real delivery of it —
  // no error anywhere, just a translation that never appeared.
  const f = fakes()
  const e = edge(f, { seen: createMemorySeen() })

  const forged = await handleRequest(e, { body: envelope('Ev1'), headers: {} })
  assert.equal(forged.status, 401)

  // Slack's own delivery of that very event is still new.
  const real = await handleRequest(e, signed(envelope('Ev1')))
  assert.equal(real.body, 'ok')
  await real.done
  assert.deepEqual(f.calls, ['Passt bei mir auch!'])
})

test('INV-app-34 a body that is valid JSON and not an object is answered, not thrown', async () => {
  // `JSON.parse('null')` succeeds. Reading a field off the result throws, and a
  // throw here escapes as a rejected promise rather than as a response — from
  // the one function that promises never to do that.
  const f = fakes()
  for (const body of ['null', '5', '"hello"', '[]']) {
    const response = await handleRequest(edge(f), signed(body))
    assert.equal(response.status, 400, body)
    assert.equal(response.body, 'not-json', body)
    await response.done
  }
  assert.deepEqual(f.calls, [])
})

test('INV-app-35 something Slack sends that we do not handle is not answered with an error', async () => {
  // `app_rate_limited` is signed, legitimate, and not an event callback. A run
  // of non-2xx responses is what makes Slack disable an app's event
  // subscriptions, so answering this with a 400 would eventually switch Brissa
  // off — because Slack told us we were going too fast.
  const f = fakes()
  const response = await handleRequest(edge(f), signed('{"type":"app_rate_limited"}'))

  assert.equal(response.status, 200)
  assert.equal(response.body, 'ignored:app_rate_limited')
  await response.done
  assert.deepEqual(f.calls, [])
})
