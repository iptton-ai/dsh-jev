import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

// Exercise the staged form model shipped by the tested DSH runtime.
// Its browser-only imports (CSS and store dependencies) are not installed in
// the Node host. A small observable supplies the public snapshot contract.
const tools = import.meta.resolve('@deepseek-ai/dsh-tools')
const uiSource = await readFile(new URL('../../dsh-client-ui-primitives/lib/index.js', tools), 'utf8')
const start = uiSource.indexOf('var SettingsFormModel = class')
assert.ok(start >= 0, 'tested host must provide SettingsFormModel')
function createSnapshotStore(initial) {
  let snapshot = initial
  const listeners = new Set()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    set(next) { snapshot = next; for (const fn of listeners) fn() },
  }
}
const SettingsFormModel = vm.runInNewContext(`${uiSource.slice(start, uiSource.indexOf('//#endregion', start))}\nSettingsFormModel`, { createSnapshotStore })
const { SlotCore } = await import(new URL('../../dsh-client-ui-slots/lib/index.js', tools))
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const bundle = await readFile(new URL(`../${manifest.exports['./client']}`, import.meta.url), 'utf8')
let registration
const jsx = (type, props) => ({ type, props })
vm.runInNewContext(bundle, { window: { __ModuleLoader__: { load: value => { registration = value } } } })
const browserPlugin = registration.factory(id => {
  if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx }
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return { SettingsForm: 'SettingsForm', SettingsSecretField: 'SettingsSecretField', SettingsFormModel }
  throw new Error(`Unexpected browser dependency: ${id}`)
})
const { JevCredentialsController } = browserPlugin
const settle = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

function scope(initial = {}) {
  let snapshot = { status: 'ready', writable: true, value: { apiKeyEnv: 'TYPESAFE_API_KEY' }, revision: 1, ...initial }
  const listeners = new Set()
  const mutations = []
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async mutate(...args) { mutations.push(args); return true },
    replace(patch) { snapshot = { ...snapshot, ...patch }; for (const fn of listeners) fn() },
    listeners, mutations,
  }
}

function setup(options = {}) {
  const form = scope(options.snapshot)
  const calls = { describe: [], set: [] }
  let info = options.info ?? { configured: false, writable: true }
  const ctx = { remote: { credentials: {
    async describe(refs) { calls.describe.push([...refs]); return options.describe ? options.describe(refs) : { ok: true, value: { [refs[0]]: info } } },
    async set(ref, value) { calls.set.push([ref, value]); if (options.set) return options.set(ref, value); info = { configured: true, writable: true }; return { ok: true } },
  } } }
  const card = new JevCredentialsController(form, ctx)
  return { form, calls, card, setInfo: next => { info = next } }
}

test('client manifest uses the official web loader and preserves the HTTP client subpath', () => {
  assert.equal(registration.id, manifest.name)
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-plugin-manager'))
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'))
  assert.equal(manifest.exports['./http-client'], './lib/client.js')
  assert.ok(browserPlugin.inject.includes('remote.credentials'))
})

test('describe reads presence only and never seeds the secret field', async () => {
  const { card, calls } = setup({ info: { configured: true, writable: true, source: 'store' } })
  await settle()
  assert.deepEqual(calls.describe, [['TYPESAFE_API_KEY']])
  const state = card.store.getSnapshot()
  assert.equal(state.credential.configured, true)
  assert.equal(state.apiKey.text, '')
  assert.equal(state.dirty, false)
  card.dispose()
})

test('save writes the secret through credentials and clears the staged literal', async () => {
  const { card, form, calls } = setup()
  await settle()
  card.inject().edit('apiKey', ' test-key ')
  assert.equal(card.store.getSnapshot().dirty, true)
  await card.form.save()
  assert.deepEqual(calls.set, [['TYPESAFE_API_KEY', 'test-key']])
  assert.deepEqual(form.mutations, [])
  assert.equal(card.store.getSnapshot().apiKey.text, '')
  assert.equal(card.store.getSnapshot().credential.configured, true)
  assert.equal(card.store.getSnapshot().failed, false)
  card.dispose()
})

test('blank input preserves the existing credential without set or unset', async () => {
  const { card, calls } = setup({ info: { configured: true, writable: true } })
  await settle()
  card.inject().edit('apiKey', '   ')
  await card.form.save()
  assert.equal(card.store.getSnapshot().dirty, false)
  assert.deepEqual(calls.set, [])
  assert.equal(card.store.getSnapshot().credential.configured, true)
  card.dispose()
})

test('failed replacement remains failed even when an old credential is configured', async () => {
  const { card, calls } = setup({ info: { configured: true, writable: true }, set: async () => ({ ok: false, error: { message: 'refused' } }) })
  await settle()
  card.inject().edit('apiKey', 'replacement-key')
  await card.form.save()
  assert.equal(calls.set.length, 1)
  assert.equal(card.store.getSnapshot().failed, true)
  assert.equal(card.store.getSnapshot().apiKey.text, 'replacement-key')
  card.dispose()
})

test('read-only credentials and read-only profiles refuse writes', async () => {
  for (const options of [
    { info: { configured: true, writable: false, source: 'env' } },
    { snapshot: { writable: false } },
  ]) {
    const { card, calls } = setup(options)
    await settle()
    assert.equal(card.store.getSnapshot().writable, false)
    card.inject().edit('apiKey', 'replacement')
    await card.form.save()
    assert.equal(calls.set.length, 0)
    card.dispose()
  }
})

test('failed credential status cannot accidentally enable writes', async () => {
  for (const describe of [async () => ({ ok: false }), async () => { throw new Error('offline') }]) {
    const { card, calls } = setup({ describe })
    await settle()
    assert.equal(card.store.getSnapshot().credential.status, 'failed')
    assert.equal(card.store.getSnapshot().invalid, true)
    card.inject().edit('apiKey', 'key')
    await card.form.save()
    assert.equal(calls.set.length, 0)
    card.dispose()
  }
})

test('reference change drops the old draft and follows the new credential', async () => {
  const { card, form, calls } = setup()
  await settle()
  card.inject().edit('apiKey', 'key-for-old-ref')
  form.replace({ value: { apiKeyEnv: 'CUSTOM_TYPESAFE_KEY' } })
  await settle()
  assert.equal(card.store.getSnapshot().apiKey.text, '')
  card.inject().edit('apiKey', 'new-key')
  await card.form.save()
  assert.deepEqual(calls.set, [['CUSTOM_TYPESAFE_KEY', 'new-key']])
  card.dispose()
})

test('out-of-order describe responses cannot replace newer reference state', async () => {
  const pending = []
  const { card, form } = setup({ describe: refs => { const d = deferred(); pending.push({ ...d, ref: refs[0] }); return d.promise } })
  form.replace({ value: { apiKeyEnv: 'NEW_REF' } })
  pending[1].resolve({ ok: true, value: { NEW_REF: { configured: true, writable: false } } })
  await settle()
  pending[0].resolve({ ok: true, value: { TYPESAFE_API_KEY: { configured: false, writable: true } } })
  await settle()
  assert.equal(card.store.getSnapshot().credential.ref, 'NEW_REF')
  assert.equal(card.store.getSnapshot().credential.configured, true)
  assert.equal(card.store.getSnapshot().writable, false)
  card.dispose()
})

test('external credential invalidation refreshes state and fences older reads for the same ref', async () => {
  const pending = []
  const { card } = setup({ describe: () => { const d = deferred(); pending.push(d); return d.promise } })
  card.refreshCredential('unrelated')
  assert.equal(pending.length, 1)
  card.refreshCredential('TYPESAFE_API_KEY')
  pending[1].resolve({ ok: true, value: { TYPESAFE_API_KEY: { configured: true, writable: true } } })
  await settle()
  pending[0].resolve({ ok: true, value: { TYPESAFE_API_KEY: { configured: false, writable: true } } })
  await settle()
  assert.equal(card.store.getSnapshot().credential.configured, true)
  card.dispose()
})

test('dispose drops the secret draft and ignores pending responses', async () => {
  const d = deferred()
  const { card, form } = setup({ describe: () => d.promise })
  card.inject().edit('apiKey', 'unsaved')
  card.dispose()
  const state = card.store.getSnapshot()
  assert.equal(state.apiKey.text, '')
  assert.equal(form.listeners.size, 0)
  d.resolve({ ok: true, value: { TYPESAFE_API_KEY: { configured: true, writable: true } } })
  await settle()
  assert.equal(card.store.getSnapshot(), state)
})

test('both detail slots register against the actual host namespace and clean up', async () => {
  for (const entryId of ['include:jev', 'jev']) {
    const core = new SlotCore()
    core.register({ name: 'root', children: {
      'plugins.bundle.config': { kind: 'keyed', scope: 'root' },
      'plugins.row.config': { kind: 'keyed', scope: 'root' },
    } }, () => null)
    const { form, card: temporary } = setup()
    temporary.dispose()
    const effects = []
    const chosen = []
    const events = new Map()
    browserPlugin.apply({
      effect(register) { effects.push(register()) },
      locale: { register: () => () => {} },
      configForms: {
        whileServed(ids, register) { assert.ok(ids.includes(entryId)); return register(new Set([entryId])) },
        get(id) { chosen.push(id); return form },
      },
      remote: {
        $on(name, listener) { events.set(name, listener); return () => events.delete(name) },
        credentials: { describe: async refs => ({ ok: true, value: { [refs[0]]: { configured: false, writable: true } } }) },
      },
      slots: { inject: (_name, register) => register(), register: (options, component) => core.register(options, component) },
    })
    await settle()
    assert.deepEqual(chosen, [entryId])
    assert.equal(core.entries('plugins.bundle.config')[0].options.key, 'dsh-jev')
    assert.equal(core.entries('plugins.row.config')[0].options.key, 'dsh-jev#jev')
    assert.equal(events.has('credentials/reference-updated'), true)
    const entry = core.entries('plugins.bundle.config')[0]
    const face = entry.inject()
    const state = face.hooks.jevCredentials.getSnapshot()
    const t = (key, params) => params ? `${key}:${params.ref}` : key
    const rendered = entry.component({ view: 'page', t, useJevCredentials: selector => selector(state), ...face })
    assert.equal(rendered.type, 'SettingsForm')
    const field = rendered.props.children[0]
    assert.equal(field.type, 'SettingsSecretField')
    assert.equal(field.props.text, '')
    assert.equal(field.props.hint, 'apiKeyHint:TYPESAFE_API_KEY')
    assert.equal(entry.component({ view: 'summary', t, useJevCredentials: selector => selector(state) }), 'description')
    for (const dispose of effects.reverse()) dispose()
    assert.equal(core.entries('plugins.bundle.config').length, 0)
    assert.equal(core.entries('plugins.row.config').length, 0)
    assert.equal(events.size, 0)
    assert.equal(form.listeners.size, 0)
  }
})
