import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { request as httpRequest } from 'node:http'
import { test } from 'node:test'
import { startServer, type CallbackQuery, type Routes } from './server.ts'

interface Response {
  readonly status: number
  readonly headers: Record<string, string | string[] | undefined>
  readonly body: string
}

/** A bare request against a running server, with redirects never followed —
 * the whole point of several tests below is inspecting the redirect itself. */
function get(port: number, path: string, method = 'GET'): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

function fakes(over: Partial<Routes> = {}) {
  const startCalls: number[] = []
  const callbackCalls: CallbackQuery[] = []
  const routes: Routes = {
    start() {
      startCalls.push(1)
      return { location: 'https://slack.com/oauth/v2/authorize?client_id=abc&state=s1' }
    },
    async callback(query) {
      callbackCalls.push(query)
      return { status: 200, body: 'Connected. You can close this tab.' }
    },
    ...over,
  }
  return { routes, startCalls, callbackCalls }
}

/** Runs `body` against a freshly started server on a random free port, and
 * always closes it afterward — even if `body` throws. */
async function withServer<T>(routes: Routes, body: (port: number) => Promise<T>): Promise<T> {
  const server = await startServer(routes, 0)
  try {
    return await body(server.port)
  } finally {
    await server.close()
  }
}

test('INV-app-85 /healthz answers without calling either route, so it cannot hang on what they do', async () => {
  const { routes, startCalls, callbackCalls } = fakes({
    start() {
      throw new Error('start must never be reached by /healthz')
    },
    callback() {
      throw new Error('callback must never be reached by /healthz')
    },
  })

  await withServer(routes, async (port) => {
    const response = await get(port, '/healthz')
    assert.equal(response.status, 200)
    assert.equal(response.body, 'ok')
  })

  assert.deepEqual(startCalls, [])
  assert.deepEqual(callbackCalls, [])
})

test('INV-app-86 /oauth/start redirects to the location start() returns', async () => {
  const { routes, startCalls } = fakes()

  await withServer(routes, async (port) => {
    const response = await get(port, '/oauth/start')
    assert.equal(response.status, 302)
    assert.equal(response.headers.location, 'https://slack.com/oauth/v2/authorize?client_id=abc&state=s1')
  })

  assert.equal(startCalls.length, 1)
})

test('INV-app-87 /oauth/callback hands the callback exactly the query Slack sent, and answers what it returns', async () => {
  const { routes, callbackCalls } = fakes({
    async callback(query) {
      callbackCalls.push(query)
      return { status: 200, body: `hello ${query.state ?? '?'}` }
    },
  })

  await withServer(routes, async (port) => {
    const response = await get(port, '/oauth/callback?code=abc123&state=xyz789')
    assert.equal(response.status, 200)
    assert.equal(response.body, 'hello xyz789')
  })

  assert.deepEqual(callbackCalls, [{ code: 'abc123', state: 'xyz789' }])
})

test('INV-app-88 the callback answer is served as plain text, whatever its body looks like — never JSON', async () => {
  const { routes } = fakes({
    async callback() {
      return { status: 200, body: JSON.stringify({ ok: true }) }
    },
  })

  await withServer(routes, async (port) => {
    const response = await get(port, '/oauth/callback?code=a&state=b')
    assert.match(String(response.headers['content-type']), /^text\/plain/)
  })
})

test('INV-app-89 an unknown path gets 404 and says nothing about what routes do exist', async () => {
  const { routes } = fakes()

  await withServer(routes, async (port) => {
    const response = await get(port, '/oauth/nope')
    assert.equal(response.status, 404)
    // The body names neither the path that was requested nor any real route —
    // a 404 that echoed `/oauth/nope` or listed `/healthz` would be telling an
    // attacker exactly what does and does not exist here.
    assert.equal(response.body, 'not found')
    assert.doesNotMatch(response.body, /healthz|oauth/)
  })
})

test('INV-app-90 a method other than GET on a known path is treated the same as an unknown path', async () => {
  const { routes, startCalls, callbackCalls } = fakes()

  await withServer(routes, async (port) => {
    const a = await get(port, '/healthz', 'POST')
    const b = await get(port, '/oauth/callback?code=a&state=b', 'POST')
    assert.equal(a.status, 404)
    assert.equal(b.status, 404)
  })

  assert.deepEqual(startCalls, [])
  assert.deepEqual(callbackCalls, [])
})

test('INV-app-91 a callback that throws answers with one fixed message, never its own text or the query it was given', async () => {
  const { routes } = fakes({
    async callback() {
      throw new Error('token exchange failed for code=super-secret-oauth-code')
    },
  })

  await withServer(routes, async (port) => {
    const response = await get(port, '/oauth/callback?code=super-secret-oauth-code&state=xyz')
    assert.equal(response.status, 500)
    assert.doesNotMatch(response.body, /super-secret-oauth-code/)
    assert.doesNotMatch(response.body, /token exchange failed/)
  })
})

test('INV-app-92 the server closes cleanly, even with a request already answered on a keep-alive connection', async () => {
  const { routes } = fakes()
  const server = await startServer(routes, 0)

  await get(server.port, '/healthz')
  // No timeout is asserted explicitly — a hang here is exactly what leaves a
  // test suite unable to exit, which `closeAllConnections()` inside `close()`
  // exists to prevent even though this connection's `keep-alive` would
  // otherwise hold the socket open past the response above.
  await server.close()

  await assert.rejects(get(server.port, '/healthz'))
})

test('INV-app-93 nothing about a callback request reaches the console, code and state included', async () => {
  const { routes } = fakes()
  const original = { log: console.log, error: console.error, warn: console.warn }
  const seen: unknown[] = []
  console.log = (...args: unknown[]) => void seen.push(args)
  console.error = (...args: unknown[]) => void seen.push(args)
  console.warn = (...args: unknown[]) => void seen.push(args)

  try {
    await withServer(routes, async (port) => {
      await get(port, '/oauth/callback?code=super-secret-oauth-code&state=xyz')
    })
  } finally {
    console.log = original.log
    console.error = original.error
    console.warn = original.warn
  }

  assert.deepEqual(seen, [])
})

test('INV-app-104 a request target Node accepts and URL refuses does not take the process down', async () => {
  // Node's HTTP parser is more permissive than WHATWG URL, and this port is
  // public. `GET http://[::1 HTTP/1.1` arrived as something Node was happy to
  // hand over and `new URL` threw on — one line of curl, one unhandled
  // rejection, and the process holding Brissa's websocket was gone. `restart =
  // always` then made a script of it.
  //
  // Driven over a raw socket because a well-formed client cannot send this.
  const running = await startServer(
    { start: () => ({ location: 'https://slack.com' }), callback: async () => ({ status: 200, body: 'ok' }) },
    0,
  )

  const ask = (line: string): Promise<string> =>
    new Promise((resolve) => {
      const socket = connect(running.port, '127.0.0.1', () => socket.write(`${line}\r\nHost: x\r\n\r\n`))
      let seen = ''
      socket.on('data', (d) => {
        seen += String(d)
        socket.end()
      })
      socket.on('close', () => resolve(seen))
      socket.on('error', () => resolve('socket error'))
      setTimeout(() => {
        socket.destroy()
        resolve('no answer')
      }, 500).unref()
    })

  for (const line of ['GET http://[::1 HTTP/1.1', 'GET http://a:b:c/ HTTP/1.1', 'GET http://%zz/ HTTP/1.1']) {
    assert.match(await ask(line), /^HTTP\/1\.1 400 /, line)
  }

  // Still answering afterwards, which is the whole assertion: the process is
  // the one holding the Slack connection.
  assert.match(await ask('GET /healthz HTTP/1.1'), /^HTTP\/1\.1 200 /)
  await running.close()
})

test('INV-app-105 a route that throws is answered, not left to take the process with it', async () => {
  // The guard added after a malformed request target killed the process, and
  // then left untested — which mutation testing found, not review. `respond` is
  // started and not awaited, so a rejection anywhere inside it has nowhere to
  // go but the process, and this process holds Brissa's websocket.
  const running = await startServer(
    {
      start: () => {
        throw new Error('something in the wiring is wrong')
      },
      callback: async () => ({ status: 200, body: 'ok' }),
    },
    0,
  )

  const answer = await fetch(`http://127.0.0.1:${running.port}/oauth/start`)
  assert.equal(answer.status, 500)
  // Nothing of the fault reaches the browser: the message is somebody's stack,
  // and the person reading it is whoever happened to open the page.
  assert.ok(!(await answer.text()).includes('wiring'))

  // Still serving, which is the assertion that matters.
  assert.equal((await fetch(`http://127.0.0.1:${running.port}/healthz`)).status, 200)
  await running.close()
})

test('INV-app-106 a request Node cannot even parse is refused at the socket', async () => {
  // Before `respond` is ever reached. Left to Node's default this is a silently
  // destroyed socket, which is survivable — but the default is not ours to
  // rely on, so it is stated and held here.
  const running = await startServer(
    { start: () => ({ location: 'https://slack.com' }), callback: async () => ({ status: 200, body: 'ok' }) },
    0,
  )

  const seen = await new Promise<string>((resolve) => {
    const socket = connect(running.port, '127.0.0.1', () => socket.write('GET /healthz HTTP/9.9\r\n\r\n'))
    let out = ''
    socket.on('data', (d) => {
      out += String(d)
    })
    socket.on('close', () => resolve(out))
    socket.on('error', () => resolve('socket error'))
    setTimeout(() => {
      socket.destroy()
      resolve(out || 'no answer')
    }, 500).unref()
  })

  assert.ok(seen.startsWith('HTTP/1.1 400') || seen === 'socket error', `got: ${JSON.stringify(seen.slice(0, 40))}`)
  assert.equal((await fetch(`http://127.0.0.1:${running.port}/healthz`)).status, 200)
  await running.close()
})
