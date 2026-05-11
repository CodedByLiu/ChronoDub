import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compressTranslation,
  translateSegments,
} from '../src/main/services/deepseek'

function createDeepseekResponse(translations: Array<{ id: number; text: string }>): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({ translations }),
          },
        },
      ],
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }
  )
}

function createCompressionResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({ text }),
          },
        },
      ],
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }
  )
}

function parseRequest(init?: RequestInit): {
  items: Array<{ id: number; text: string; max_chars?: number }>
  systemPrompt: string
} {
  if (!init?.body || typeof init.body !== 'string') {
    throw new Error('Missing request body')
  }

  const payload = JSON.parse(init.body) as {
    messages?: Array<{ role?: string; content?: string }>
  }
  const systemPrompt = payload.messages?.find((msg) => msg.role === 'system')?.content
  const userContent = payload.messages?.find((msg) => msg.role === 'user')?.content

  if (!systemPrompt || !userContent) {
    throw new Error('Invalid request payload')
  }

  return {
    items: JSON.parse(userContent) as Array<{ id: number; text: string; max_chars?: number }>,
    systemPrompt,
  }
}

test('translateSegments includes max_chars when budget map is provided', async () => {
  const originalFetch = globalThis.fetch
  let inspected = false

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const { items, systemPrompt } = parseRequest(init)
    inspected = true
    assert.match(systemPrompt, /max_chars/i)
    assert.deepEqual(items, [{ id: 0, text: 'Open settings.', max_chars: 8 }])
    return createDeepseekResponse([{ id: 0, text: '\u6253\u5f00\u8bbe\u7f6e\u3002' }])
  }) as typeof fetch

  try {
    const outcome = await translateSegments(
      [{ id: 0, text: 'Open settings.' }],
      'test-key',
      [],
      new Map([[0, 8]])
    )
    assert.equal(outcome.translations.get(0), '\u6253\u5f00\u8bbe\u7f6e\u3002')
    assert.equal(outcome.issues.length, 0)
    assert.equal(inspected, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('translateSegments recovers missing ids with single-item retry', async () => {
  const sourceItems = [
    { id: 0, text: 'Open settings and scroll down.' },
    { id: 1, text: 'Then click apply to continue.' },
  ]

  const zhLine0 = '\u6253\u5f00\u8bbe\u7f6e\u5e76\u5411\u4e0b\u6eda\u52a8\u3002'
  const zhLine1 = '\u7136\u540e\u70b9\u51fb\u5e94\u7528\u4ee5\u7ee7\u7eed\u3002'

  const originalFetch = globalThis.fetch
  let batchCalls = 0
  let singleCalls = 0

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const { items } = parseRequest(init)
    if (items.length === 2) {
      batchCalls += 1
      return createDeepseekResponse([{ id: 0, text: zhLine0 }])
    }
    if (items.length === 1 && items[0].id === 1) {
      singleCalls += 1
      return createDeepseekResponse([{ id: 1, text: zhLine1 }])
    }
    throw new Error('Unexpected request shape')
  }) as typeof fetch

  try {
    const outcome = await translateSegments(sourceItems, 'test-key', [])
    assert.equal(outcome.translations.get(0), zhLine0)
    assert.equal(outcome.translations.get(1), zhLine1)
    assert.equal(outcome.issues.length, 0)
    assert.equal(batchCalls, 3)
    assert.equal(singleCalls, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('translateSegments falls back to last raw output when retries exhaust', async () => {
  const source = 'Please keep this sentence exactly as English.'
  const originalFetch = globalThis.fetch
  let callCount = 0

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    callCount += 1
    const { items } = parseRequest(init)
    return createDeepseekResponse([{ id: items[0].id, text: source }])
  }) as typeof fetch

  try {
    const outcome = await translateSegments([{ id: 0, text: source }], 'test-key', [])
    assert.equal(outcome.translations.get(0), source)
    assert.equal(outcome.issues.length, 1)
    assert.equal(outcome.issues[0]?.id, 0)
    assert.equal(outcome.issues[0]?.text, source)
    assert.equal(callCount, 5)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('translateSegments keeps max_chars on issue items in fallback mode', async () => {
  const source = 'Please keep this sentence exactly as English.'
  const originalFetch = globalThis.fetch

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const { items } = parseRequest(init)
    return createDeepseekResponse([{ id: items[0].id, text: source }])
  }) as typeof fetch

  try {
    const outcome = await translateSegments(
      [{ id: 0, text: source }],
      'test-key',
      [],
      new Map([[0, 12]])
    )
    assert.equal(outcome.translations.get(0), source)
    assert.equal(outcome.issues.length, 1)
    assert.equal(outcome.issues[0]?.max_chars, 12)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('translateSegments retries over-compressed sentence translations', async () => {
  const source = 'This is the string.'
  const overCompressed = '\u5b57\u7b26\u4e32\u3002'
  const fullSentence = '\u8fd9\u5c31\u662f\u8fd9\u4e2a\u5b57\u7b26\u4e32\u3002'

  const originalFetch = globalThis.fetch
  let callCount = 0

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    callCount += 1
    const { items } = parseRequest(init)
    if (callCount === 1) {
      return createDeepseekResponse([{ id: items[0].id, text: overCompressed }])
    }
    return createDeepseekResponse([{ id: items[0].id, text: fullSentence }])
  }) as typeof fetch

  try {
    const outcome = await translateSegments([{ id: 0, text: source }], 'test-key', [])
    assert.equal(outcome.translations.get(0), fullSentence)
    assert.equal(outcome.issues.length, 0)
    assert.equal(callCount, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('translateSegments allows short technical tokens unchanged', async () => {
  const originalFetch = globalThis.fetch
  let strictPromptCalls = 0

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const { items, systemPrompt } = parseRequest(init)
    if (systemPrompt.includes('Must return exactly one translation for every input id')) {
      strictPromptCalls += 1
    }
    return createDeepseekResponse([{ id: items[0].id, text: 'HTTP' }])
  }) as typeof fetch

  try {
    const outcome = await translateSegments([{ id: 0, text: 'HTTP' }], 'test-key', [])
    assert.equal(outcome.translations.get(0), 'HTTP')
    assert.equal(outcome.issues.length, 0)
    assert.equal(strictPromptCalls, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('translateSegments flags paraphrased full-English output as issue', async () => {
  const source = 'Open settings and scroll down.'
  const englishParaphrase = 'Please continue by opening settings and scrolling down.'
  const originalFetch = globalThis.fetch
  let callCount = 0

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    callCount += 1
    const { items } = parseRequest(init)
    return createDeepseekResponse([{ id: items[0].id, text: englishParaphrase }])
  }) as typeof fetch

  try {
    const outcome = await translateSegments([{ id: 0, text: source }], 'test-key', [])
    assert.equal(outcome.translations.get(0), englishParaphrase)
    assert.equal(outcome.issues.length, 1)
    assert.equal(outcome.issues[0]?.id, 0)
    assert.equal(callCount, 5)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('translateSegments short-circuits letter-recitation source without calling DeepSeek', async () => {
  const source = 'a  b  b  a'
  const originalFetch = globalThis.fetch
  let callCount = 0

  globalThis.fetch = (async () => {
    callCount += 1
    throw new Error('fetch should not be called for untranslatable source')
  }) as typeof fetch

  try {
    const outcome = await translateSegments([{ id: 0, text: source }], 'test-key', [])
    assert.equal(outcome.translations.get(0), 'a b b a')
    assert.equal(outcome.issues.length, 0)
    assert.equal(callCount, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('translateSegments accepts short Chinese when budget is tight', async () => {
  const source = 'there is no value yet'
  const concise = '没有值'
  const originalFetch = globalThis.fetch
  let callCount = 0

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    callCount += 1
    const { items } = parseRequest(init)
    return createDeepseekResponse([{ id: items[0].id, text: concise }])
  }) as typeof fetch

  try {
    const outcome = await translateSegments(
      [{ id: 0, text: source }],
      'test-key',
      [],
      new Map([[0, 10]])
    )
    assert.equal(outcome.translations.get(0), concise)
    assert.equal(outcome.issues.length, 0)
    assert.equal(callCount, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('compressTranslation retries when candidate regresses to full English', async () => {
  const originalFetch = globalThis.fetch
  let callCount = 0

  globalThis.fetch = (async () => {
    callCount += 1
    if (callCount === 1) {
      return createCompressionResponse('Open settings and continue.')
    }
    return createCompressionResponse('\u5148\u6253\u5f00\u8bbe\u7f6e\u518d\u7ee7\u7eed\u3002')
  }) as typeof fetch

  try {
    const compressed = await compressTranslation('\u5148\u6253\u5f00\u8bbe\u7f6e\uff0c\u7136\u540e\u7ee7\u7eed\u4e0b\u4e00\u6b65\u3002', 12, 'test-key')
    assert.equal(compressed, '\u5148\u6253\u5f00\u8bbe\u7f6e\u518d\u7ee7\u7eed\u3002')
    assert.equal(callCount, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})
