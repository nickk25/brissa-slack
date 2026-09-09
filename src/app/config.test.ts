import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { readChannels, readConfig } from './config.ts'

const complete = {
  SLACK_BOT_TOKEN: 'xoxb-x',
  SLACK_APP_TOKEN: 'xapp-x',
  ANTHROPIC_API_KEY: 'sk-x',
}

test('INV-app-39 a channel is off unless it is listed, and no channels is not an error', async () => {
  // The product's whole disposition. Starting silent everywhere is the honest
  // first state rather than a misconfiguration.
  assert.deepEqual(readChannels('C1, C2 ,'), [
    { channelId: 'C1', enabled: true },
    { channelId: 'C2', enabled: true },
  ])
  assert.deepEqual(readChannels(''), [])

  const configured = readConfig(complete)
  assert.ok(configured.ok)
  assert.deepEqual(configured.config.channels, [])
})

test('INV-app-40 every problem is reported at once, not the first one', async () => {
  // The person reading this message is doing setup for the first time. Telling
  // them one thing, four times, is four restarts.
  const configured = readConfig({})
  assert.ok(!configured.ok)
  assert.equal(configured.problems.length, 3)
  for (const name of ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'ANTHROPIC_API_KEY']) {
    assert.ok(
      configured.problems.some((p) => p.includes(name)),
      name,
    )
  }
})

test('INV-app-41 the model is the one that was measured, unless something says otherwise', async () => {
  // Named here rather than defaulted inside the adapter, because which model
  // runs is a decision recorded in docs/DECISIONS.md and scored by the eval.
  const fallback = readConfig(complete)
  assert.ok(fallback.ok && fallback.config.model === 'claude-sonnet-5')

  const chosen = readConfig({ ...complete, BRISSA_MODEL: 'claude-opus-5' })
  assert.ok(chosen.ok && chosen.config.model === 'claude-opus-5')
})

test('INV-app-67 a missing user token is a working state, not a fault', async () => {
  // Without it `/translate` cannot read a channel and says so, while the
  // message-menu shortcut carries its own text and is unaffected. Requiring it
  // would make everyone grant a broad read permission for a feature that never
  // needed one.
  const without = readConfig(complete)
  assert.ok(without.ok)
  assert.equal(without.config.userToken, undefined)

  const with_ = readConfig({ ...complete, SLACK_USER_TOKEN: 'xoxp-x' })
  assert.ok(with_.ok && with_.config.userToken === 'xoxp-x')

  // Blank is the same as absent: an empty line in `.env` must not become a token.
  const blank = readConfig({ ...complete, SLACK_USER_TOKEN: '   ' })
  assert.ok(blank.ok && blank.config.userToken === undefined)
})

test('INV-app-84 enrolment has somewhere to live, and the environment can move it', async () => {
  // The default is fine on a laptop and wrong on Fly, where a path outside a
  // volume means every deploy forgets everybody. Only this module reads the
  // environment, so this is the one place that decision can be made.
  const fallback = readConfig(complete)
  assert.ok(fallback.ok && fallback.config.enrolmentPath === 'data/enrolment.json')

  const onAVolume = readConfig({ ...complete, BRISSA_ENROLMENT_PATH: '/data/enrolment.json' })
  assert.ok(onAVolume.ok && onAVolume.config.enrolmentPath === '/data/enrolment.json')
})

test('INV-app-102 OAuth is configured wholly or not at all', async () => {
  // A link built from a client id with no secret behind it walks somebody
  // through Slack's consent screen to a callback that cannot complete. "Not set
  // up" is a better answer than that, so a partial configuration is none.
  const off = readConfig(complete)
  assert.ok(off.ok && off.config.oauth === undefined)

  const half = readConfig({ ...complete, SLACK_CLIENT_ID: '123.456' })
  assert.ok(half.ok && half.config.oauth === undefined, 'an id without a secret is not a configuration')

  // The signing secret counts as part of it: a `state` signed with an empty
  // string is not signed, and anyone could mint one.
  const noSecret = readConfig({ ...complete, SLACK_CLIENT_ID: '1', SLACK_CLIENT_SECRET: 's', BRISSA_PUBLIC_URL: 'https://x.test' })
  assert.ok(noSecret.ok && noSecret.config.oauth === undefined, 'no signing secret is not a configuration')

  // The encryption key counts too: OAuth being on is the moment Brissa starts
  // holding credentials that are not its own, and storing those in the clear is
  // not a thing to fall back to.
  const noKey = readConfig({
    ...complete,
    SLACK_SIGNING_SECRET: 's',
    SLACK_CLIENT_ID: '1',
    SLACK_CLIENT_SECRET: 's',
    BRISSA_PUBLIC_URL: 'https://x.test',
  })
  assert.ok(noKey.ok && noKey.config.oauth === undefined, 'no encryption key is not a configuration')

  const whole = readConfig({
    ...complete,
    // A real 32 bytes. The old fixture was 44 characters of 'a', which decodes
    // to 33 — the store would have refused it, and only the config test's never
    // handing it to the store kept that hidden.
    BRISSA_TOKENS_KEY: randomBytes(32).toString('base64'),
    SLACK_SIGNING_SECRET: 'a-signing-secret',
    SLACK_CLIENT_ID: '123.456',
    SLACK_CLIENT_SECRET: 'shh',
    // A trailing slash here becomes a double slash in the redirect URI, and
    // Slack compares that string exactly against what app settings hold.
    BRISSA_PUBLIC_URL: 'https://brissa.fly.dev/',
  })
  assert.ok(whole.ok)
  assert.deepEqual(whole.config.oauth, {
    clientId: '123.456',
    clientSecret: 'shh',
    publicUrl: 'https://brissa.fly.dev',
  })
})

test('INV-app-103 credentials and preferences are kept in different files', async () => {
  // Merging them for tidiness would put a bearer credential wherever a language
  // preference is convenient to read.
  // Asserting two default literals differ proves nothing; what matters is that
  // pointing them at one file is refused rather than quietly accepted.
  const same = readConfig({
    ...complete,
    BRISSA_ENROLMENT_PATH: '/data/everything.json',
    BRISSA_TOKENS_PATH: '/data/everything.json',
  })
  assert.ok(!same.ok, 'one file for both must not start')
  assert.ok(same.ok === false && same.problems.some((p) => p.includes('same file')))

  const apart = readConfig(complete)
  assert.ok(apart.ok)
  assert.notEqual(apart.config.tokensPath, apart.config.enrolmentPath)
})

test('INV-app-111 a key that is set and wrong is a problem, not a stack trace', async () => {
  // `createFileTokens` throws on a bad key, and it is called from the
  // composition root outside any handler. So a mistyped BRISSA_TOKENS_KEY
  // printed the config banner, then an uncaught exception, and Fly's
  // `restart = always` turned that into a loop. The message was legible in the
  // trace, but this is exactly the class of mistake `readConfig` exists to
  // collect — somebody doing setup for the first time, pasting by hand.
  const short = readConfig({ ...complete, BRISSA_TOKENS_KEY: 'dG9vLXNob3J0' })
  assert.ok(!short.ok)
  assert.ok(
    short.problems.some((p) => p.includes('BRISSA_TOKENS_KEY')),
    'the problem has to name the variable somebody has to go and fix',
  )

  // 44 characters of 'a' decodes to 33 bytes, not 32 — the near miss that a
  // length check on the string rather than the bytes would wave through.
  assert.ok(!readConfig({ ...complete, BRISSA_TOKENS_KEY: 'a'.repeat(44) }).ok)

  // Absent is not wrong: it means OAuth is off, which is a working state.
  assert.ok(readConfig(complete).ok)
  assert.ok(readConfig({ ...complete, BRISSA_TOKENS_KEY: randomBytes(32).toString('base64') }).ok)
})

test('INV-app-116 BRISSA_READERS is not needed to start, and is refused if it is there', async () => {
  // It used to be required, and it used to win. Who reads what is now written
  // by each person with `/brissa` and lives in the enrolment file — so an
  // install with people already enrolled must start with this unset, and an
  // install that still has it must not start quietly pretending it matters.
  //
  // Refused rather than ignored on purpose: a variable that is present and
  // inert is how the next person to ask "why won't my languages stick" gets
  // misled exactly the way this bug misled its first reader.
  assert.ok(readConfig(complete).ok, 'no BRISSA_READERS is the normal state now')

  const stillSet = readConfig({ ...complete, BRISSA_READERS: 'U-nick:es,en' })
  assert.ok(!stillSet.ok)
  const problem = stillSet.problems.find((p) => p.includes('BRISSA_READERS'))
  assert.ok(problem, 'the variable has to be named, or nobody knows what to unset')
  assert.ok(problem?.includes('/brissa'), 'and it has to say what replaced it')

  // Whitespace is not a configuration. Somebody who half-deleted the line
  // should start, not be held at the door by a space.
  assert.ok(readConfig({ ...complete, BRISSA_READERS: '   ' }).ok)
})
