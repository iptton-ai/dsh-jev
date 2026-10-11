import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { DEFAULTS, buildRequest, evaluateJev, evaluationURL, retryDelayMs, validateResponse } from '../lib/client.js'

const sample = JSON.parse(await readFile(new URL('../examples/support-triage.json', import.meta.url), 'utf8'))
const response = () => ({
  model: 'jev-1.13.0',
  answers: {
    is_urgent: { type: 'noul', noul: 0.95 },
    department: { type: 'choice', choice: 'billing', probabilities: { billing: 0.88, technical: 0.12, sales: 0 }, confidence: 0.81 },
    frustration: { type: 'score', score: 1.05, legend: { 0: '平静', 1: '不满', 2: '非常愤怒' }, probabilities: { 0: 0, 1: 0.95, 2: 0.05 }, confidence: 0.92 },
  },
  usage: { input_tokens: 304, output_tokens: 52 },
})
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers })
const expectCode = code => error => error.code === code
const options = fetchImpl => ({ apiKey: 'test-api-key', fetchImpl })

// Each fixture exercises the external API's shape, rather than a private helper implementation.
test('mixed questions retain structured state/instructions and zero-based score levels', () => {
  const args = structuredClone(sample)
  args.questions.department.instructions = { question: 'Pick a team', extra_context: ['payments'] }
  args.questions.department.criteria.sales = null
  args.questions.frustration.criteria[0] = { severity: 'calm' }
  const request = buildRequest(args)
  assert.equal(request.model, DEFAULTS.model)
  assert.deepEqual(request.state, sample.state)
  assert.deepEqual(request.questions, args.questions)
  assert.equal(buildRequest({ ...args, model: 'jev-pinned' }).model, 'jev-pinned')
  assert.equal(buildRequest(args, 'configured-model').model, 'configured-model')
})

for (const [label, mutate] of [
  ['empty questions', value => { value.questions = {} }],
  ['invalid state', value => { value.state = true }],
  ['missing instructions', value => { delete value.questions.is_urgent.instructions }],
  ['unknown question type', value => { value.questions.is_urgent.type = 'chat' }],
  ['extra request field', value => { value.apiKey = 'not-a-tool-parameter' }],
  ['extra question field', value => { value.questions.is_urgent.temperature = 1 }],
  ['choice array', value => { value.questions.department.criteria = ['billing', 'technical'] }],
  ['too many choices', value => { value.questions.department.criteria = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [i, null])) }],
  ['score object', value => { value.questions.frustration.criteria = { 0: 'calm', 1: 'angry' } }],
  ['one score level', value => { value.questions.frustration.criteria = ['calm'] }],
  ['too many score levels', value => { value.questions.frustration.criteria = Array(11).fill('level') }],
  ['invalid noul criteria', value => { value.questions.is_urgent.criteria = { yes: 'urgent' } }],
  ['null model', value => { value.model = null }],
  ['lossy JSON', value => { value.state = { value: undefined } }],
  ['circular JSON', value => { value.state.self = value.state }],
]) {
  test(`reject ${label} before any HTTP request`, async () => {
    const value = structuredClone(sample)
    mutate(value)
    let calls = 0
    await assert.rejects(evaluateJev(value, options(async () => { calls++; return json(response()) })), expectCode('JEV_INVALID_ARGUMENTS'))
    assert.equal(calls, 0)
  })
}

test('send exact API body and return full response including future fields', async () => {
  const answer = { ...response(), request_metadata: { id: 'r-1' } }
  let calls = 0
  const result = await evaluateJev(sample, options(async (url, init) => {
    calls++
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone')
    assert.equal(init.method, 'POST')
    assert.equal(init.headers.authorization, 'Bearer test-api-key')
    assert.equal(init.headers['accept-encoding'], 'identity')
    assert.equal(init.redirect, 'error')
    assert.ok(init.signal instanceof AbortSignal)
    assert.deepEqual(JSON.parse(init.body), { ...sample, model: 'jev-latest' })
    return json(answer)
  }))
  assert.equal(calls, 1)
  assert.deepEqual(result, answer)
})

test('missing credential fails without HTTP', async () => {
  let calls = 0
  await assert.rejects(evaluateJev(sample, { fetchImpl: async () => { calls++ } }), expectCode('JEV_MISSING_CREDENTIAL'))
  assert.equal(calls, 0)
})

test('Retry-After supports seconds, HTTP dates and fallback backoff', () => {
  const now = Date.parse('2026-10-10T00:00:00Z')
  assert.equal(retryDelayMs(new Headers({ 'retry-after': '1.5' }), 0, now), 1500)
  assert.equal(retryDelayMs(new Headers({ 'retry-after': 'Sat, 10 Oct 2026 00:00:04 GMT' }), 0, now), 4000)
  assert.equal(retryDelayMs(new Headers({ 'retry-after': 'garbage' }), 2, now, () => 0.5), 4000)
})

for (const status of [429, 529]) {
  test(`retry ${status} then succeed with the same body`, async () => {
    const bodies = []
    const result = await evaluateJev(sample, { ...options(async (_url, init) => {
      bodies.push(init.body)
      return bodies.length < 3 ? json({ message: 'busy' }, status, { 'retry-after': '0' }) : json(response())
    }), maxRetries: 2 })
    assert.deepEqual(result, response())
    assert.equal(bodies.length, 3)
    assert.equal(new Set(bodies).size, 1)
  })
}

test('retry exhaustion and zero-retry setting report HTTP failure', async () => {
  for (const maxRetries of [0, 2]) {
    let calls = 0
    await assert.rejects(evaluateJev(sample, { ...options(async () => {
      calls++
      return json({ message: 'busy' }, 429, { 'retry-after': '0' })
    }), maxRetries }), error => error.code === 'JEV_HTTP_ERROR' && error.status === 429)
    assert.equal(calls, maxRetries + 1)
  }
})

for (const status of [401, 403, 422, 500]) {
  test(`do not retry HTTP ${status} and redact the credential from errors`, async () => {
    let calls = 0
    await assert.rejects(evaluateJev(sample, options(async () => {
      calls++
      return json({ message: 'bad key test-api-key' }, status, { 'x-request-id': 'request-1' })
    })), error => {
      assert.equal(error.code, 'JEV_HTTP_ERROR')
      assert.equal(error.status, status)
      assert.equal(error.requestId, 'request-1')
      assert.ok(!error.message.includes('test-api-key'))
      return true
    })
    assert.equal(calls, 1)
  })
}

test('network failures are sanitized and do not cause duplicate paid calls', async () => {
  let calls = 0
  await assert.rejects(evaluateJev(sample, options(async () => {
    calls++
    throw new Error('socket failed with test-api-key')
  })), error => error.code === 'JEV_NETWORK_ERROR' && !error.message.includes('test-api-key'))
  assert.equal(calls, 1)
})

test('reject non-JSON successful responses', async () => {
  await assert.rejects(evaluateJev(sample, options(async () => new Response('<html>gateway</html>'))), expectCode('JEV_INVALID_RESPONSE'))
})

for (const [label, mutate] of [
  ['missing answer', value => { delete value.answers.is_urgent }],
  ['mismatched type', value => { value.answers.is_urgent.type = 'score' }],
  ['invalid probability', value => { value.answers.is_urgent.noul = 2 }],
  ['unknown choice', value => { value.answers.department.choice = 'other' }],
  ['incomplete distribution', value => { delete value.answers.department.probabilities.billing }],
  ['out-of-range score', value => { value.answers.frustration.score = 3 }],
  ['missing score legend', value => { delete value.answers.frustration.legend }],
  ['invalid usage', value => { value.usage.input_tokens = -1 }],
]) {
  test(`reject ${label} from upstream`, () => {
    const value = response()
    mutate(value)
    assert.throws(() => validateResponse(value, sample.questions), expectCode('JEV_INVALID_RESPONSE'))
  })
}

function untilAborted(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(signal.reason)
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

test('total timeout covers fetch and body reading', async () => {
  for (const fetchImpl of [
    async (_url, init) => untilAborted(init.signal),
    async (_url, init) => ({ ok: true, text: async () => untilAborted(init.signal) }),
  ]) {
    await assert.rejects(evaluateJev(sample, { ...options(fetchImpl), timeoutMs: 15 }), expectCode('JEV_TIMEOUT'))
  }
})

test('total timeout bounds long Retry-After waits without making another request', async () => {
  for (const retryAfter of ['60', '2592000', '1e307', 'Sat, 10 Oct 2099 00:00:00 GMT']) {
    let calls = 0
    await assert.rejects(evaluateJev(sample, { ...options(async () => {
      calls++
      return json({}, 529, { 'retry-after': retryAfter })
    }), timeoutMs: 15 }), expectCode('JEV_TIMEOUT'))
    assert.equal(calls, 1, `must honor Retry-After: ${retryAfter} without overflowing the timer`)
  }
})

test('caller cancellation propagates into fetch', async () => {
  const controller = new AbortController()
  let received
  const promise = evaluateJev(sample, { ...options(async (_url, init) => {
    received = init.signal
    return untilAborted(init.signal)
  }), signal: controller.signal })
  controller.abort()
  await assert.rejects(promise, expectCode('JEV_CANCELLED'))
  assert.equal(received.aborted, true)
})

test('pre-cancelled calls never fetch', async () => {
  let calls = 0
  await assert.rejects(evaluateJev(sample, {
    ...options(async () => { calls++ }), signal: AbortSignal.abort(),
  }), expectCode('JEV_CANCELLED'))
  assert.equal(calls, 0)
})

test('validate endpoint configuration before sending credentials', () => {
  assert.equal(evaluationURL('https://proxy.example/typesafe/'), 'https://proxy.example/typesafe/v1/systemone')
  assert.equal(evaluationURL('http://127.0.0.1:1234'), 'http://127.0.0.1:1234/v1/systemone')
  for (const value of ['http://example.com', 'file:///tmp/key', 'https://user:key@example.com', 'https://api.typesafe.ai?key=x', 'https://api.typesafe.ai#x']) {
    assert.throws(() => evaluationURL(value), expectCode('JEV_INVALID_ARGUMENTS'))
  }
})
