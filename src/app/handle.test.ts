/**
 * The only tests in this repository that can fail because two modules disagree.
 *
 * Every other suite checks one module against its own contract, and a suite like
 * that cannot see the failures that matter most here: a translation rendered
 * into blocks nobody sends, a skip that spends a model call anyway, a refusal
 * counted as a delivery. So these assert on **what the fakes recorded**, and
 * most of all on what they recorded *nothing* of. An absence of side effects is
 * not observable any other way.
 *
 * `deepEqual` against the whole recorded list, never `.some()`: a test that asks
 * whether the right call happened will pass happily while three wrong ones
 * happen beside it.
 */

import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import type { ChannelPolicy, Reader } from '../core/ports.ts'
import { renderTranslation } from '../core/render.ts'
import type { TranslationRequest, TranslationResult, Translator } from '../core/translator.ts'
import { createTranslator, type MessagesApi } from '../llm/decide.ts'
import type { EphemeralRequest, SlackApi } from '../slack/send.ts'
import { fallbackText } from '../slack/send.ts'
import type { SlackMessageEvent } from '../slack/receive.ts'
import { createMemoryDirectory } from '../store/memory.ts'
import { handleMessage, type Ports } from './handle.ts'

const nick: Reader = { userId: 'U-nick', reads: ['es', 'en'] }
const ana: Reader = { userId: 'U-ana', reads: ['es', 'en'] }
const bo: Reader = { userId: 'U-bo', reads: ['de'] }
const on: ChannelPolicy = { channelId: 'C1', enabled: true }

const GERMAN = 'Passt bei mir auch, ich melde mich morgen.'
const SPANISH = 'A mí también me viene bien, te escribo mañana.'

const event = (over: Partial<SlackMessageEvent> = {}): SlackMessageEvent => ({
  type: 'message',
  channel: 'C1',
  user: 'U-jens',
  text: GERMAN,
  ts: '1700000000.000100',
  ...over,
})

const translated = (text: string, foundLanguages: readonly string[] = ['de']): TranslationResult => ({
  kind: 'translated',
  translation: { text, foundLanguages },
})

/** Records every request, and answers however the test says. */
function fakeTranslator(reply: (request: TranslationRequest) => TranslationResult) {
  const calls: TranslationRequest[] = []
  const translator: Translator = {
    async translate(request) {
      calls.push(request)
      return reply(request)
    },
  }
  return { translator, calls }
}

/** Records every post, and answers per user however the test says. */
function fakeSlack(answers: Record<string, { ok: boolean; error?: string }> = {}) {
  const posts: EphemeralRequest[] = []
  const api: SlackApi = {
    async postEphemeral(request) {
      posts.push(request)
      return answers[request.user] ?? { ok: true }
    },
  }
  return { api, posts }
}

const wire = (readers: readonly Reader[], translator: Translator, slack: SlackApi, policy = on): Ports => ({
  directory: createMemoryDirectory({ readers, channels: [policy] }),
  translator,
  slack,
})

test('INV-app-01 one message reaches every reader who needed it, and nobody else', async () => {
  const t = fakeTranslator((r) => (r.reads[0] === 'es' ? translated(SPANISH) : { kind: 'silent' }))
  const s = fakeSlack()
  const outcome = await handleMessage(wire([nick, ana, bo], t.translator, s.api), event())

  // Two distinct reads tuples, two calls. Not three: nick and ana share one.
  assert.deepEqual(t.calls, [
    { text: GERMAN, reads: ['es', 'en'] },
    { text: GERMAN, reads: ['de'] },
  ])

  const expected = {
    channel: 'C1',
    blocks: renderTranslation({ text: SPANISH, foundLanguages: ['de'] }),
    text: fallbackText(SPANISH),
  }
  assert.deepEqual(s.posts, [
    { ...expected, user: 'U-nick' },
    { ...expected, user: 'U-ana' },
  ])

  assert.deepEqual(outcome, {
    kind: 'considered',
    readers: [
      { userId: 'U-nick', kind: 'delivered' },
      { userId: 'U-ana', kind: 'delivered' },
      { userId: 'U-bo', kind: 'silent' },
    ],
  })
})

test('INV-app-02 readers who read the same languages cost one model call, not one each', async () => {
  // The request carries no reader identity, so two identical requests are two
  // payments for one answer — and two chances to get different answers for the
  // same message, a difference between colleagues no counter could explain.
  const t = fakeTranslator(() => translated(SPANISH))
  const s = fakeSlack()
  await handleMessage(wire([nick, ana], t.translator, s.api), event())

  assert.equal(t.calls.length, 1)
  assert.deepEqual(s.posts.map((p) => p.user), ['U-nick', 'U-ana'])
})

test('INV-app-03 the same languages in a different order are a different translation', async () => {
  // `src/llm/decide.ts` translates into `reads[0]`, so grouping by the set
  // rather than the ordered tuple would silently give one of the two readers a
  // translation into a language they did not ask for.
  const flipped: Reader = { userId: 'U-flip', reads: ['en', 'es'] }
  const t = fakeTranslator(() => translated(SPANISH))
  await handleMessage(wire([nick, flipped], t.translator, fakeSlack().api), event())

  assert.deepEqual(t.calls, [
    { text: GERMAN, reads: ['es', 'en'] },
    { text: GERMAN, reads: ['en', 'es'] },
  ])
})

test('INV-app-04 silence is an answer with a shape, not an empty list', async () => {
  // The whole product is restraint, so "nothing was sent" is the common case and
  // must stay distinguishable from "nothing was considered".
  const t = fakeTranslator(() => ({ kind: 'silent' }))
  const s = fakeSlack()
  const outcome = await handleMessage(wire([nick, bo], t.translator, s.api), event())

  assert.deepEqual(s.posts, [])
  assert.deepEqual(outcome, {
    kind: 'considered',
    readers: [
      { userId: 'U-nick', kind: 'silent' },
      { userId: 'U-bo', kind: 'silent' },
    ],
  })
})

test('INV-app-05 a translation failure is visible, attributed, and confined to its group', async () => {
  const t = fakeTranslator((r) =>
    r.reads[0] === 'es' ? { kind: 'failed', detail: 'overloaded' } : translated('Passt.', ['de']),
  )
  const s = fakeSlack()
  const outcome = await handleMessage(wire([nick, ana, bo], t.translator, s.api), event())

  // The failing group sent nothing; the healthy one was untouched by it.
  assert.deepEqual(s.posts.map((p) => p.user), ['U-bo'])
  assert.deepEqual(outcome, {
    kind: 'considered',
    readers: [
      { userId: 'U-nick', kind: 'failed', stage: 'translate', detail: 'overloaded' },
      { userId: 'U-ana', kind: 'failed', stage: 'translate', detail: 'overloaded' },
      { userId: 'U-bo', kind: 'delivered' },
    ],
  })
})

test('INV-app-06 a port that throws becomes an outcome, never a rejected promise', async () => {
  // The caller is an HTTP handler that must answer Slack whatever happened. A
  // thrown error there becomes a Slack retry, which becomes a second copy of
  // every ephemeral — exactly when something is already wrong.
  const t = fakeTranslator(() => {
    throw new Error('socket hang up')
  })
  const outcome = await handleMessage(wire([nick], t.translator, fakeSlack().api), event())

  assert.deepEqual(outcome, {
    kind: 'considered',
    readers: [{ userId: 'U-nick', kind: 'failed', stage: 'translate', detail: 'socket hang up' }],
  })
})

test('INV-app-07 a reader who was not there is not a failure, and a refusal is not an absence', async () => {
  // One of the two is the expected answer for a message that arrived overnight.
  // The other is somebody's job. Collapsing them would hide an outage behind the
  // product's own normal behaviour.
  const t = fakeTranslator(() => translated(SPANISH))
  const s = fakeSlack({
    'U-ana': { ok: false, error: 'user_not_in_channel' },
    'U-nick': { ok: false, error: 'missing_scope' },
  })
  const outcome = await handleMessage(wire([nick, ana], t.translator, s.api), event())

  assert.deepEqual(outcome, {
    kind: 'considered',
    readers: [
      { userId: 'U-nick', kind: 'not-delivered', because: 'declined', detail: 'missing_scope' },
      { userId: 'U-ana', kind: 'not-delivered', because: 'reader-not-in-channel', detail: 'user_not_in_channel' },
    ],
  })
})

test('INV-app-08 a send that throws is the sending module’s failure, not the model’s', async () => {
  // Same word, two owners. `stage` is what says which one has work to do.
  const t = fakeTranslator(() => translated(SPANISH))
  const slack: SlackApi = {
    async postEphemeral() {
      throw new Error('ECONNRESET')
    },
  }
  const outcome = await handleMessage(wire([nick], t.translator, slack), event())

  assert.deepEqual(outcome, {
    kind: 'considered',
    readers: [{ userId: 'U-nick', kind: 'failed', stage: 'send', detail: 'ECONNRESET' }],
  })
})

test('INV-app-09 a disabled channel spends nothing at all', async () => {
  // Not an early return in the wiring: `shouldAsk` decides, per reader, and the
  // count of skips is the honest number of reader-message pairs. Checking the
  // policy here instead would duplicate the rule outside the core.
  const t = fakeTranslator(() => translated(SPANISH))
  const s = fakeSlack()
  const ports = wire([nick, bo], t.translator, s.api, { channelId: 'C1', enabled: false })
  const outcome = await handleMessage(ports, event())

  assert.deepEqual(t.calls, [])
  assert.deepEqual(s.posts, [])
  assert.deepEqual(outcome, {
    kind: 'considered',
    readers: [
      { userId: 'U-nick', kind: 'skipped', because: 'channel-disabled' },
      { userId: 'U-bo', kind: 'skipped', because: 'channel-disabled' },
    ],
  })
})

test('INV-app-10 the author is dropped before grouping, not after', async () => {
  // He shares a reads tuple with a real recipient, so a group formed before
  // `shouldAsk` would have posted him his own words back.
  const jens: Reader = { userId: 'U-jens', reads: ['es', 'en'] }
  const t = fakeTranslator(() => translated(SPANISH))
  const s = fakeSlack()
  const outcome = await handleMessage(wire([jens, nick], t.translator, s.api), event())

  assert.equal(t.calls.length, 1)
  assert.deepEqual(s.posts.map((p) => p.user), ['U-nick'])
  assert.deepEqual(outcome, {
    kind: 'considered',
    readers: [
      { userId: 'U-jens', kind: 'skipped', because: 'own-message' },
      { userId: 'U-nick', kind: 'delivered' },
    ],
  })
})

test('INV-app-11 a reader who has declared no languages never reaches the model', async () => {
  // The translator can only fail such a request. Grouping before `shouldAsk`
  // would turn a skip that has a reason into a failure that has a stack trace.
  const t = fakeTranslator(() => translated(SPANISH))
  const outcome = await handleMessage(
    wire([{ userId: 'U-new', reads: [] }], t.translator, fakeSlack().api),
    event(),
  )

  assert.deepEqual(t.calls, [])
  assert.deepEqual(outcome, {
    kind: 'considered',
    readers: [{ userId: 'U-new', kind: 'skipped', because: 'reader-reads-nothing' }],
  })
})

test('INV-app-12 a bot message and a message with nothing to read both cost nothing', async () => {
  for (const e of [event({ bot_id: 'B1' }), event({ text: ':tada: <@U9>' })]) {
    const t = fakeTranslator(() => translated(SPANISH))
    const s = fakeSlack()
    await handleMessage(wire([nick], t.translator, s.api), e)
    assert.deepEqual(t.calls, [])
    assert.deepEqual(s.posts, [])
  }
})

test('INV-app-13 a channel Brissa knows nobody in says so, rather than returning an empty list', async () => {
  const t = fakeTranslator(() => translated(SPANISH))
  const ports: Ports = {
    directory: createMemoryDirectory({ channels: [on] }),
    translator: t.translator,
    slack: fakeSlack().api,
  }
  assert.deepEqual(await handleMessage(ports, event()), { kind: 'nobody-to-tell' })
  assert.deepEqual(t.calls, [])
})

test('INV-app-14 an event that was never a message is rejected by name, before anything is looked up', async () => {
  let looked = 0
  const ports: Ports = {
    directory: {
      async lookup(channelId) {
        looked++
        return { policy: { channelId, enabled: true }, readers: [nick] }
      },
    },
    translator: fakeTranslator(() => translated(SPANISH)).translator,
    slack: fakeSlack().api,
  }

  assert.deepEqual(await handleMessage(ports, event({ subtype: 'message_changed' })), {
    kind: 'rejected',
    because: 'edited-or-special',
  })
  assert.deepEqual(await handleMessage(ports, event({ type: 'reaction_added' })), {
    kind: 'rejected',
    because: 'not-a-message',
  })
  assert.equal(looked, 0)
})

test('INV-app-15 a directory that breaks is reported as a broken directory', async () => {
  // Distinct from every silence above. If this arrived as `nobody-to-tell`, an
  // outage in the store would be indistinguishable from an empty workspace.
  const ports: Ports = {
    directory: {
      async lookup() {
        throw new Error('connection refused')
      },
    },
    translator: fakeTranslator(() => translated(SPANISH)).translator,
    slack: fakeSlack().api,
  }
  assert.deepEqual(await handleMessage(ports, event()), {
    kind: 'lookup-failed',
    detail: 'connection refused',
  })
})

test('INV-app-16 a translation lands in the thread it belongs to, and a top-level one carries no thread at all', async () => {
  // Absence rather than `undefined`: the two are distinguishable under
  // `exactOptionalPropertyTypes`, and Slack treats a present `thread_ts` of
  // `undefined` as a malformed request rather than as a top-level post.
  const t = fakeTranslator(() => translated(SPANISH))

  const threaded = fakeSlack()
  await handleMessage(wire([nick], t.translator, threaded.api), event({ thread_ts: '1699.9' }))
  assert.equal(threaded.posts[0]?.thread_ts, '1699.9')

  const top = fakeSlack()
  await handleMessage(wire([nick], t.translator, top.api), event())
  assert.equal(top.posts.length, 1)
  assert.ok(top.posts[0] !== undefined && !('thread_ts' in top.posts[0]))
})

test('INV-app-17 escaping survives the seam between rendering and sending', async () => {
  // `escapeMrkdwn` runs inside `renderTranslation`. This is the test that fails
  // if the wiring ever sends the raw text alongside, or instead of, the blocks.
  const t = fakeTranslator(() => translated('Usa <b> y & luego dime'))
  const s = fakeSlack()
  await handleMessage(wire([nick], t.translator, s.api), event())

  const section = s.posts[0]?.blocks[0]
  assert.ok(section?.type === 'section')
  assert.equal(section.text.text, 'Usa &lt;b&gt; y &amp; luego dime')
})

test('INV-app-18 the same event twice does the work twice, because deduplication is not this function’s job', async () => {
  // Slack's retry count and event id live in the envelope, which `receive` never
  // sees. Pretending to deduplicate here would be a guarantee this function
  // cannot keep; the HTTP edge is the only place that can. Asserted rather than
  // assumed, so nobody later reads the absence as a bug.
  const t = fakeTranslator(() => translated(SPANISH))
  const s = fakeSlack()
  const ports = wire([nick], t.translator, s.api)
  await handleMessage(ports, event())
  await handleMessage(ports, event())

  assert.equal(t.calls.length, 2)
  assert.equal(s.posts.length, 2)
})

test('INV-app-19 the real adapters compose: a Slack event becomes an ephemeral with no fake in between', async () => {
  // Every other test above fakes the `Translator` port, which means none of them
  // can see the model adapter's own seams: parsing the JSON, mapping language
  // codes to names, producing the block shape. This one fakes only the two edges
  // that would otherwise need a network — the Anthropic SDK and the Slack client
  // — and runs everything between them for real.
  let seenSystem = ''
  let seenContent: string | undefined
  const messages: MessagesApi = {
    async create(request) {
      seenSystem = request.system
      seenContent = request.messages[0]?.content
      return {
        content: [
          { type: 'text', text: JSON.stringify({ translate: true, languages: ['de'], text: SPANISH }) },
        ],
      }
    },
  }

  const t = createTranslator(messages, {
    model: 'test',
    promptPath: fileURLToPath(new URL('../llm/prompts/decide.md', import.meta.url)),
  })
  const s = fakeSlack()
  const outcome = await handleMessage(wire([nick], t, s.api), event())

  // The prompt reached the model with the reader's languages filled in.
  assert.ok(seenSystem.includes('Spanish'))
  assert.ok(!seenSystem.includes('{{TARGET}}'))
  assert.equal(seenContent, GERMAN)

  // And `de` arrived at the reader as a language name, not as a code.
  assert.deepEqual(s.posts, [
    {
      channel: 'C1',
      user: 'U-nick',
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: SPANISH } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: 'Translated from German · only visible to you' }] },
      ],
      text: fallbackText(SPANISH),
    },
  ])
  assert.deepEqual(outcome, {
    kind: 'considered',
    readers: [{ userId: 'U-nick', kind: 'delivered' }],
  })
})
