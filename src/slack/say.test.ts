import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readSayCommand } from './say.ts'

const payload = (text: string, over: Record<string, unknown> = {}) => ({
  command: '/say',
  text,
  team_id: 'T1',
  user_id: 'U-nick',
  response_url: 'https://hooks.slack.test/x',
  ...over,
})

test('INV-slack-98 `/say de: hola` reads as German plus the text, folding case and region', async () => {
  const read = readSayCommand(payload('de: Hola, ¿podemos mover la reunión?'))
  assert.ok(read.ok)
  assert.equal(read.command.into, 'de')
  assert.equal(read.command.text, 'Hola, ¿podemos mover la reunión?')

  // The same folding `/brissa` does, through the same function, so the two
  // cannot drift into disagreeing about what `de-AT` means.
  for (const token of ['DE:', 'de-AT:', 'De-at:']) {
    const folded = readSayCommand(payload(`${token} Guten Tag`))
    assert.ok(folded.ok, token)
    assert.equal(folded.command.into, 'de', token)
  }

  // Only the first colon is the delimiter. A sentence may contain as many
  // more as it likes.
  const colons = readSayCommand(payload('de: Nota: la reunión es a las 13.00'))
  assert.ok(colons.ok)
  assert.equal(colons.command.text, 'Nota: la reunión es a las 13.00')
})

test('INV-slack-99 a leading two-letter word is never read as a language without the delimiter', async () => {
  // The reason this file exists. `de`, `en`, `es`, `no`, `se`, `si`, `la`,
  // `el`, `te` are all real ISO 639-1 codes and all common openers of Spanish
  // sentences. The dangerous one is not `/say no puedo ir` — that comes back
  // as Norwegian and is visibly wrong. It is this:
  //
  //     /say de verdad que no llego
  //
  // where the language reads as German, which is probably what they wanted,
  // and the text silently becomes `verdad que no llego`. Fluent German of a
  // sentence nobody wrote, about to be pasted to a client, with nothing about
  // it looking wrong. Refused rather than guessed at.
  for (const text of [
    'de verdad que no llego',
    'en casa no tengo el archivo',
    'no puedo ir mañana',
    'si te parece bien lo movemos',
    'el contrato está firmado',
    'la reunión es el martes',
    'se lo paso a Anna',
  ]) {
    const read = readSayCommand(payload(text))
    assert.ok(!read.ok, text)
    assert.equal(read.because, 'no-language', text)
    // And it must be answerable, or the caller is left with silence.
    assert.equal(read.responseUrl, 'https://hooks.slack.test/x', text)
  }
})

test('INV-slack-100 a language with nothing after it is refused by name, not translated as emptiness', async () => {
  for (const text of ['de:', 'de:   ', '  de:  ']) {
    const read = readSayCommand(payload(text))
    assert.ok(!read.ok, text)
    assert.equal(read.because, 'no-text', text)
    assert.equal(read.responseUrl, 'https://hooks.slack.test/x', text)
  }

  // Told apart from a missing language on purpose: one person forgot the
  // delimiter, the other stopped halfway. They need different sentences back.
  const nothing = readSayCommand(payload(''))
  assert.ok(!nothing.ok)
  assert.equal(nothing.because, 'no-language')

  // A colon that is not preceded by a language code is not a delimiter.
  const notALanguage = readSayCommand(payload('Nota: la reunión es el martes'))
  assert.ok(!notALanguage.ok)
  assert.equal(notALanguage.because, 'no-language')
})

test('INV-slack-101 a payload missing what it needs is refused by name, and answered wherever it can be', async () => {
  // Mirrors `readEnrolCommand`: Slack acknowledged the command before any of
  // this ran, so a refusal the caller cannot hear is indistinguishable from a
  // command that quietly did nothing.
  assert.deepEqual(readSayCommand(null), { ok: false, because: 'not-a-command' })
  assert.deepEqual(readSayCommand('/say de: hola'), { ok: false, because: 'not-a-command' })
  assert.deepEqual(readSayCommand([]), { ok: false, because: 'not-a-command' })

  // No response_url is the one refusal that cannot carry one.
  const nowhere = readSayCommand({ ...payload('de: hola'), response_url: undefined })
  assert.deepEqual(nowhere, { ok: false, because: 'no-response-url' })

  for (const [field, because] of [
    ['team_id', 'no-team'],
    ['user_id', 'no-user'],
  ] as const) {
    const read = readSayCommand({ ...payload('de: hola'), [field]: undefined })
    assert.ok(!read.ok, field)
    assert.equal(read.because, because, field)
    assert.equal(read.responseUrl, 'https://hooks.slack.test/x', field)
  }
})
