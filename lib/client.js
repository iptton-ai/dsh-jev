import { setTimeout as wait } from 'node:timers/promises'

export const DEFAULTS = Object.freeze({
  apiKeyEnv: 'TYPESAFE_API_KEY',
  baseURL: 'https://api.typesafe.ai',
  model: 'jev-latest',
  timeoutMs: 60_000,
  maxRetries: 2,
})

export class JevError extends Error {
  constructor(message, code, details = {}) {
    super(message)
    this.name = 'JevError'
    this.code = code
    Object.assign(this, details)
  }
}

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [null, Object.prototype].includes(Object.getPrototypeOf(value))
const invalid = message => { throw new JevError(message, 'JEV_INVALID_ARGUMENTS') }

function assertJson(value, path, parents = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (!Array.isArray(value) && !isRecord(value)) invalid(`${path} must contain only JSON values.`)
  if (parents.has(value)) invalid(`${path} must not contain circular references.`)
  parents.add(value)
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) assertJson(value[i], `${path}[${i}]`, parents)
  } else {
    for (const [key, item] of Object.entries(value)) assertJson(item, `${path}.${key}`, parents)
  }
  parents.delete(value)
}

function assertEntry(value, path, nullable = false) {
  if (nullable && value === null) return
  if (typeof value !== 'string' && !Array.isArray(value) && !isRecord(value)) {
    invalid(`${path} must be a string, JSON object or array${nullable ? ', or null' : ''}.`)
  }
  assertJson(value, path)
}

function assertKeys(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) invalid(`${path}.${key} is not a supported field.`)
  }
}

/** Validate the API's named question map before resolving a key or making a paid request. */
export function buildRequest(args, defaultModel = DEFAULTS.model) {
  if (!isRecord(args)) invalid('Arguments must be a JSON object.')
  assertKeys(args, ['state', 'questions', 'model'], 'arguments')
  assertEntry(args.state, 'state')
  if (!isRecord(args.questions) || Object.keys(args.questions).length === 0) {
    invalid('questions must be a non-empty object keyed by question ID.')
  }
  const model = Object.hasOwn(args, 'model') ? args.model : defaultModel
  if (typeof model !== 'string' || !model.trim()) invalid('model must be a non-empty string.')

  for (const [id, question] of Object.entries(args.questions)) {
    const path = `questions[${JSON.stringify(id)}]`
    if (!id.trim()) invalid('Question IDs must not be empty.')
    if (!isRecord(question)) invalid(`${path} must be a question object.`)
    assertKeys(question, ['type', 'instructions', 'criteria'], path)
    if (!['noul', 'choice', 'score'].includes(question.type)) {
      invalid(`${path}.type must be noul, choice or score.`)
    }
    assertEntry(question.instructions, `${path}.instructions`)
    if (question.type === 'noul') {
      if (question.criteria !== undefined && question.criteria !== null) {
        if (!isRecord(question.criteria)) invalid(`${path}.criteria must be an object with true/false descriptions.`)
        assertKeys(question.criteria, ['true', 'false'], `${path}.criteria`)
        for (const [label, description] of Object.entries(question.criteria)) {
          assertEntry(description, `${path}.criteria.${label}`, true)
        }
      }
    } else if (question.type === 'choice') {
      if (!isRecord(question.criteria)) invalid(`${path}.criteria must be a map of option labels to descriptions.`)
      const entries = Object.entries(question.criteria)
      if (entries.length < 1 || entries.length > 255) invalid(`${path}.criteria must contain 1–255 options.`)
      for (const [label, description] of entries) {
        if (!label.trim()) invalid(`${path}.criteria option labels must not be empty.`)
        assertEntry(description, `${path}.criteria[${JSON.stringify(label)}]`, true)
      }
    } else {
      if (!Array.isArray(question.criteria) || question.criteria.length < 2 || question.criteria.length > 10) {
        invalid(`${path}.criteria must be an ordered array of 2–10 levels, indexed from zero.`)
      }
      question.criteria.forEach((description, index) => assertEntry(description, `${path}.criteria[${index}]`, true))
    }
  }
  const request = { state: args.state, model, questions: args.questions }
  assertJson(request, 'request')
  return request
}

export function evaluationURL(baseURL = DEFAULTS.baseURL) {
  let url
  try { url = new URL(baseURL) } catch { invalid('baseURL must be an absolute HTTP(S) URL.') }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    invalid('baseURL must use HTTPS (HTTP is allowed for a local loopback endpoint).')
  }
  if (url.username || url.password || url.search || url.hash) {
    invalid('baseURL must not contain credentials, query parameters or a fragment.')
  }
  return `${url.href.replace(/\/+$/, '')}/v1/systemone`
}

const responseError = detail => { throw new JevError(`Invalid TypeSafe response: ${detail}`, 'JEV_INVALID_RESPONSE') }
const sameKeys = (record, expected) => isRecord(record)
  && Object.keys(record).length === expected.length && expected.every(key => Object.hasOwn(record, key))
const isProbability = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1

/** Keep the full JSON response, while rejecting missing or mismatched answers. */
export function validateResponse(value, questions) {
  if (!isRecord(value) || typeof value.model !== 'string' || !value.model) responseError('model is missing.')
  if (!sameKeys(value.answers, Object.keys(questions))) responseError('answers must match the requested question IDs.')
  if (!isRecord(value.usage) || !['input_tokens', 'output_tokens'].every(key =>
    Number.isSafeInteger(value.usage[key]) && value.usage[key] >= 0)) responseError('token usage is missing or malformed.')

  for (const [id, question] of Object.entries(questions)) {
    const answer = value.answers[id]
    if (!isRecord(answer) || answer.type !== question.type) responseError(`answer type does not match question ${JSON.stringify(id)}.`)
    if (question.type === 'noul') {
      if (!isProbability(answer.noul)) responseError(`noul must be between 0 and 1 for ${JSON.stringify(id)}.`)
      continue
    }
    if (!isProbability(answer.confidence)) responseError(`confidence must be between 0 and 1 for ${JSON.stringify(id)}.`)
    const labels = question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index))
    if (!sameKeys(answer.probabilities, labels) || !Object.values(answer.probabilities).every(isProbability)) {
      responseError(`probabilities must cover every criterion for ${JSON.stringify(id)}.`)
    }
    if (question.type === 'choice') {
      if (typeof answer.choice !== 'string' || !labels.includes(answer.choice)) responseError(`choice is not a requested option for ${JSON.stringify(id)}.`)
    } else {
      if (!Number.isFinite(answer.score) || answer.score < 0 || answer.score > labels.length - 1) {
        responseError(`score is outside the rubric for ${JSON.stringify(id)}.`)
      }
      if (!sameKeys(answer.legend, labels)) responseError(`legend must cover every score level for ${JSON.stringify(id)}.`)
    }
  }
  return value
}

/** Honor Retry-After; fallback retries use bounded exponential backoff with jitter. */
export function retryDelayMs(headers, attempt, now = Date.now(), random = Math.random) {
  const retryAfter = headers.get('retry-after')
  if (retryAfter !== null && retryAfter.trim()) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000)
    const date = Date.parse(retryAfter)
    if (Number.isFinite(date)) return Math.max(0, date - now)
  }
  return Math.round(Math.min(10_000, 1000 * 2 ** attempt) * (0.75 + random() * 0.5))
}

const STATUS_HINTS = {
  401: 'The TypeSafe API key is missing or invalid; check the configured credential.',
  403: 'The TypeSafe API key does not have permission for this request.',
  422: 'TypeSafe rejected the request; check the state and question rubrics.',
  429: 'TypeSafe rate limit exceeded; try again later.',
  529: 'TypeSafe is temporarily overloaded; try again later.',
}

function httpError(response, text, apiKey) {
  let detail = ''
  try {
    const body = JSON.parse(text)
    const message = body?.message ?? body?.error?.message ?? body?.detail
    if (message !== undefined) detail = typeof message === 'string' ? message : JSON.stringify(message)
  } catch { /* HTML/proxy bodies are not useful API errors. */ }
  detail = detail.split(apiKey).join('[redacted]').slice(0, 1200)
  const requestId = response.headers.get('x-request-id') ?? response.headers.get('request-id')
  return new JevError(`TypeSafe HTTP ${response.status}: ${STATUS_HINTS[response.status] ?? 'Evaluation failed.'}${detail ? ` ${detail}` : ''}`, 'JEV_HTTP_ERROR', {
    status: response.status,
    ...(requestId ? { requestId: requestId.split(apiKey).join('[redacted]') } : {}),
  })
}

/** One total timeout includes fetch, response body reads and retry waits. Network failures are not retried. */
export async function evaluateJev(args, options = {}) {
  const request = buildRequest(args, options.model ?? DEFAULTS.model)
  const url = evaluationURL(options.baseURL ?? DEFAULTS.baseURL)
  const apiKey = options.apiKey?.trim()
  if (!apiKey) throw new JevError(`Configure ${DEFAULTS.apiKeyEnv} through DSH credentials before calling jev_evaluate.`, 'JEV_MISSING_CREDENTIAL')
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs
  const maxRetries = options.maxRetries ?? DEFAULTS.maxRetries
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) invalid('timeoutMs must be an integer between 1 and 600000.')
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) invalid('maxRetries must be an integer between 0 and 5.')

  const timeout = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal
  const timer = setTimeout(() => timeout.abort(), timeoutMs)
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const body = JSON.stringify(request)
  try {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted()
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'accept-encoding': 'identity',
        },
        body,
        redirect: 'error',
        signal,
      })
      const text = await response.text()
      signal.throwIfAborted()
      if (!response.ok) {
        if ([429, 529].includes(response.status) && attempt < maxRetries) {
          // Bound the timer to prevent Node's >2^31-1 ms overflow. The total
          // deadline starts first and aborts this wait if Retry-After exceeds it.
          await wait(Math.min(retryDelayMs(response.headers, attempt), timeoutMs), undefined, { signal })
          continue
        }
        throw httpError(response, text, apiKey)
      }
      let result
      try { result = JSON.parse(text) } catch { responseError('expected a JSON body.') }
      return validateResponse(result, request.questions)
    }
  } catch (error) {
    if (options.signal?.aborted) throw new JevError('JEV evaluation was cancelled.', 'JEV_CANCELLED')
    if (timeout.signal.aborted) throw new JevError(`JEV evaluation exceeded the total ${timeoutMs} ms timeout (including retries).`, 'JEV_TIMEOUT')
    if (error instanceof JevError) throw error
    throw new JevError('Unable to connect to TypeSafe; check the network or proxy and retry.', 'JEV_NETWORK_ERROR')
  } finally {
    clearTimeout(timer)
  }
}
