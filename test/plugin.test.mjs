import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { Config, name, inject, apply } from '../lib/index.js'
import { DEFAULTS } from '../lib/client.js'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { ToolRuntime, assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

const live = value => value && typeof value.get === 'function' ? value.get() : value
const args = { state: 'Please fix my payouts today.', questions: { urgent: { type: 'noul', instructions: 'Is this urgent?' } } }
const result = { model: 'jev-1.13.0', answers: { urgent: { type: 'noul', noul: 0.95 } }, usage: { input_tokens: 100, output_tokens: 10 } }
const exec = signal => ({ signal: signal ?? new AbortController().signal })

function register(config, resolve = async () => ({ value: 'test-key', source: 'test' })) {
  const tools = []
  const disposers = []
  let disposed = false
  apply({
    effect(fn) { disposers.push(fn()) },
    tools: { register(tool) { tools.push(tool); return () => { disposed = true } } },
    credentials: { resolve },
  }, config)
  return { tool: tools[0], dispose: () => disposers.forEach(fn => fn()), isDisposed: () => disposed }
}

test('module contract, Config defaults and compiled DSH schemas', () => {
  assert.equal(name, 'jev')
  assert.deepEqual(inject, ['tools', 'credentials'])
  const config = Config({})
  for (const [key, value] of Object.entries(DEFAULTS)) assert.equal(live(config[key]), value)
  const { tool, dispose, isDisposed } = register(config)
  assert.equal(tool.name, 'jev_evaluate')
  assertSupportedJsonSchema(tool.parameters)
  assertSupportedJsonSchema(tool.output.schema)
  assert.deepEqual(validateJsonSchemaValue(tool.parameters, args), [])
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, result), [])
  assert.equal(tool.presentCall(args).title, 'JEV 评估 · 1 个问题')
  assert.equal(tool.isConcurrencySafe(args), true)
  assert.deepEqual(JSON.parse(tool.output.render(args, result)[0].text), result)
  dispose()
  assert.equal(isDisposed(), true)
})

test('reject invalid config numbers through the actual schemastery parser', () => {
  assert.throws(() => Config({ timeoutMs: 0 }))
  assert.throws(() => Config({ maxRetries: 6 }))
  assert.throws(() => Config({ maxRetries: 1.5 }))
})

test('missing credentials produce an actionable reference-specific error', async () => {
  let refs = []
  const { tool } = register(Config({ apiKeyEnv: 'CUSTOM_TYPESAFE_KEY' }), async ref => { refs.push(ref); return undefined })
  await assert.rejects(tool.execute(args, exec()), error => error instanceof HarnessError && error.code === 'JEV_MISSING_CREDENTIAL' && error.message.includes('CUSTOM_TYPESAFE_KEY'))
  assert.deepEqual(refs, ['CUSTOM_TYPESAFE_KEY'])
})

test('malformed questions fail before credential lookup', async () => {
  let calls = 0
  const { tool } = register(Config({}), async () => { calls++ })
  await assert.rejects(tool.execute({ ...args, questions: { urgent: { type: 'score', instructions: 'Score', criteria: ['one'] } } }, exec()), /2–10/)
  assert.equal(calls, 0)
  await assert.rejects(tool.execute({ ...args, state: true }, exec()), /state/)
})

test('real DSH execution pipeline retains JEV failure codes', async t => {
  const tools = import.meta.resolve('@deepseek-ai/dsh-tools')
  const { Context } = await import(new URL('../../cordis/lib/index.js', tools))
  const ctx = new Context()
  const fiber = ctx.plugin(function setup(ctx) {
    ctx.provide('systemPrompt', { tools: () => () => {} })
    ctx.provide('credentials', { resolve: async () => undefined })
    new ToolRuntime(ctx)
    apply(ctx, Config({}))
  })
  t.after(() => fiber.dispose())
  await fiber.await()
  const runtime = ctx.get('tools')
  for (const [arguments_, code] of [
    [args, 'JEV_MISSING_CREDENTIAL'],
    [{ ...args, questions: { urgent: { type: 'score', instructions: 'Score', criteria: ['one'] } } }, 'JEV_INVALID_ARGUMENTS'],
  ]) {
    const outcome = await runtime.execute({ callId: code, name: 'jev_evaluate', arguments: arguments_, signal: exec().signal })
    assert.equal(outcome.isError, true)
    assert.deepEqual(outcome.error.info, { name: 'JevError', code })
  }
})

test('pre-cancelled tool calls fail before credential lookup', async () => {
  let calls = 0
  const { tool } = register(Config({}), async () => { calls++ })
  await assert.rejects(tool.execute(args, exec(AbortSignal.abort())))
  assert.equal(calls, 0)
})

test('real HTTP integration: credentials rotate and volatile config is read for every call', async t => {
  const requests = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    requests.push({ path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(result))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))

  let model = 'configured-first'
  let key = 'key-one'
  const refs = []
  const config = { ...Config({ baseURL: `http://127.0.0.1:${server.address().port}`, maxRetries: 0 }), model: { get: () => model } }
  const { tool } = register(config, async ref => { refs.push(ref); return { value: key, source: 'test' } })
  assert.deepEqual(await tool.execute(args, exec()), result)
  key = 'key-two'
  model = 'configured-second'
  assert.deepEqual(await tool.execute(args, exec()), result)
  assert.deepEqual(await tool.execute({ ...args, model: 'per-call-model' }, exec()), result)
  assert.deepEqual(refs, ['TYPESAFE_API_KEY', 'TYPESAFE_API_KEY', 'TYPESAFE_API_KEY'])
  assert.deepEqual(requests.map(req => req.headers.authorization), ['Bearer key-one', 'Bearer key-two', 'Bearer key-two'])
  assert.deepEqual(requests.map(req => req.body.model), ['configured-first', 'configured-second', 'per-call-model'])
  assert.ok(requests.every(req => req.path === '/v1/systemone' && req.headers['accept-encoding'] === 'identity'))
})

test('bundle manifest has no runtime core dependencies or lifecycle scripts', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.dsh.manifestVersion, 1)
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dependencies, undefined)
  for (const peer of Object.keys(manifest.peerDependencies)) assert.equal(manifest.peerDependenciesMeta[peer].optional, true)
  for (const script of ['preinstall', 'install', 'postinstall', 'prepare']) assert.equal(manifest.scripts[script], undefined)
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /id: jev/)
  assert.match(patch, /name: dsh-jev/)
})

test('host compatibility preflight accepts the current runtime', async () => {
  // Resolve in the linked host dependency closure, not another version in the workspace.
  const tools = import.meta.resolve('@deepseek-ai/dsh-tools')
  const host = new URL('../../dsh-app-boot/lib/index.js', tools)
  const { evaluatePluginCompatibility } = await import(host)
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(evaluatePluginCompatibility(manifest, {}, '0.2.0-rc.2'), undefined)
  assert.ok(evaluatePluginCompatibility(manifest, {}, '0.1.7'))
})
