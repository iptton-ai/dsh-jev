// Static DSH web plugin bundle. Shared React and controls come from the host.
window.__ModuleLoader__.load({
  id: 'dsh-jev',
  factory: require => {
    const { jsx, jsxs } = require('react/jsx-runtime')
    const { SettingsForm, SettingsSecretField, SettingsFormModel } = require('@deepseek-ai/dsh-client-ui-primitives')
    const DEFAULT_REF = 'TYPESAFE_API_KEY'
    const NS = 'plugins.jev'
    // Bundle rows are loaded through the profile's include group. A direct
    // root entry uses the unprefixed id instead.
    const ENTRY_IDS = ['include:jev', 'jev']
    const inject = ['slots', 'locale', 'remote', 'remote.credentials', 'configForms']
    const dictionaries = {
      zh: {
        description: '使用 TypeSafe JEV 进行结构化评估。',
        apiKey: 'TypeSafe API Key',
        apiKeyHint: '凭据引用：{ref}。密钥保存到 DSH 凭据服务；留空保留现有密钥，保存后下一次调用生效。',
        configured: '已配置',
        unconfigured: '未配置',
        loading: '读取配置状态…',
        failed: '无法读取凭据状态，请刷新当前页面重试。',
        readOnlyState: '已配置 · 只读',
        readOnly: '当前配置或凭据来源为只读。请在原来源更新密钥。',
        unavailable: 'jev 插件当前未加载，暂时无法配置。',
        save: '保存',
        saving: '保存中…',
        saveFailed: '密钥未保存，已保留输入供你重试。',
      },
      en: {
        description: 'Structured evaluations with TypeSafe JEV.',
        apiKey: 'TypeSafe API Key',
        apiKeyHint: 'Credential reference: {ref}. Stored by DSH credentials. Leave blank to keep the current key; a saved key takes effect on the next call.',
        configured: 'Configured',
        unconfigured: 'Not configured',
        loading: 'Reading credential status…',
        failed: 'Could not read credential status. Refresh this page to retry.',
        readOnlyState: 'Configured · read-only',
        readOnly: 'The configuration or credential source is read-only. Update the key at its source.',
        unavailable: 'The jev plugin is not loaded; configuration is unavailable.',
        save: 'Save',
        saving: 'Saving…',
        saveFailed: 'The key was not saved. Your input is kept so you can retry.',
      },
    }

    function refOf(scope) {
      const value = scope.getSnapshot().value?.apiKeyEnv
      return typeof value === 'string' && value.length > 0 ? value : DEFAULT_REF
    }

    class JevCredentialsController {
      constructor(scope, ctx) {
        this.scope = scope
        this.ctx = ctx
        this.generation = 0
        this.disposed = false
        this.credential = { ref: refOf(scope), status: 'loading', configured: false, writable: false }
        this.form = new SettingsFormModel(scope, [], [{ field: 'apiKey', write: value => this.writeKey(value) }])
        this.store = this.form.bind(() => this.projection())
        this.unsubscribe = scope.subscribe(() => {
          if (refOf(scope) !== this.credential.ref) {
            // A draft belongs to the reference displayed when it was typed.
            this.form.actions().discard()
            void this.readCredential()
          }
        })
        void this.readCredential()
      }

      projection() {
        const shell = this.form.shell()
        return {
          ...shell,
          writable: shell.writable && (this.credential.status !== 'ready' || this.credential.writable),
          invalid: shell.invalid || this.credential.status !== 'ready',
          apiKey: this.form.field('apiKey'),
          credential: { ...this.credential },
        }
      }

      async readCredential() {
        if (this.disposed) return
        const ref = refOf(this.scope)
        const generation = ++this.generation
        this.credential = { ref, status: 'loading', configured: false, writable: false }
        this.store.set(this.projection())
        try {
          const response = await this.ctx.remote.credentials.describe([ref])
          if (this.disposed || generation !== this.generation || ref !== refOf(this.scope)) return
          const info = response.ok ? response.value[ref] : undefined
          this.credential = info
            ? { ref, status: 'ready', configured: info.configured === true, writable: info.writable === true }
            : { ref, status: 'failed', configured: false, writable: false }
        } catch {
          if (this.disposed || generation !== this.generation || ref !== refOf(this.scope)) return
          this.credential = { ref, status: 'failed', configured: false, writable: false }
        }
        this.store.set(this.projection())
      }

      refreshCredential(ref) {
        if (ref === this.credential.ref) void this.readCredential()
      }

      async writeKey(value) {
        const ref = refOf(this.scope)
        if (this.disposed || this.credential.ref !== ref || this.credential.status !== 'ready'
          || !this.credential.writable || !this.scope.getSnapshot().writable) return false
        const response = await this.ctx.remote.credentials.set(ref, value)
        // Existing configured state cannot prove that this replacement succeeded.
        if (!response.ok) return false
        await this.readCredential()
        return true
      }

      inject() {
        return { hooks: { jevCredentials: this.store }, ...this.form.actions() }
      }

      dispose() {
        this.disposed = true
        this.generation++
        this.unsubscribe()
        this.form.actions().discard()
        this.form.dispose()
      }
    }

    function JevCredentialsPage(props) {
      const state = props.useJevCredentials(snapshot => snapshot)
      const { t } = props
      if (props.view === 'summary') return t('description')
      const credential = state.credential
      const stateLabel = credential.status !== 'ready' ? t(credential.status)
        : !credential.configured ? t('unconfigured')
          : !credential.writable ? t('readOnlyState') : t('configured')
      return jsxs(SettingsForm, {
        state,
        labels: {
          unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'),
          save: t('save'), saving: t('saving'),
        },
        onSave: props.save,
        onDiscard: props.discard,
        children: [jsx(SettingsSecretField, {
          id: 'plugin-config-jev-api-key',
          label: t('apiKey'),
          hint: t('apiKeyHint', { ref: credential.ref }),
          text: state.apiKey.text,
          disabled: !state.writable || state.saving || credential.status !== 'ready',
          configured: credential.configured,
          stateLabel,
          onEdit: text => props.edit('apiKey', text),
        })],
      })
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, dictionaries), 'jev: locale')
      ctx.effect(() => ctx.configForms.whileServed(ENTRY_IDS, served => {
        const entryId = ENTRY_IDS.find(id => served.has(id))
        const card = new JevCredentialsController(ctx.configForms.get(entryId), ctx)
        const cleanup = []
        try {
          cleanup.push(() => card.dispose())
          cleanup.push(ctx.remote.$on('credentials/reference-updated', ref => card.refreshCredential(ref)))
          for (const [name, key] of [['plugins.bundle.config', 'dsh-jev'], ['plugins.row.config', 'dsh-jev#jev']]) {
            cleanup.push(ctx.slots.inject(name, () => ctx.slots.register({
              name, key, locale: NS, inject: () => card.inject(),
            }, JevCredentialsPage)))
          }
        } catch (error) {
          for (const dispose of cleanup.reverse()) dispose()
          throw error
        }
        return () => { for (const dispose of cleanup.reverse()) dispose() }
      }), 'jev: plugin details')
    }

    return { name: 'jev-settings', inject, apply, JevCredentialsController }
  },
})
