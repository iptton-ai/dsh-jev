import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { DEFAULTS, JevError, buildRequest, evaluateJev } from './client.js'
import { PARAMETERS, OUTPUT_SCHEMA } from './schema.js'

export const name = 'jev'
export const inject = ['tools', 'credentials']

export const Config = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULTS.apiKeyEnv).volatile()
    .description('TypeSafe API key 的 DSH 凭据引用名称。实际密钥由凭据服务读取，不写进工具参数。'),
  baseURL: z.string().default(DEFAULTS.baseURL).volatile()
    .description('TypeSafe API 根地址；插件追加 /v1/systemone。默认 https://api.typesafe.ai。'),
  model: z.string().default(DEFAULTS.model).volatile()
    .description('默认 JEV 模型；工具调用可通过 model 覆盖。'),
  timeoutMs: z.number().step(1).min(1000).max(600_000).default(DEFAULTS.timeoutMs).volatile()
    .description('每次工具调用的总超时，单位毫秒，包含响应读取与重试等待。'),
  maxRetries: z.number().step(1).min(0).max(5).default(DEFAULTS.maxRetries).volatile()
    .description('429/529 响应的最大重试次数，使用 Retry-After 或指数退避。'),
})

const live = value => value && typeof value.get === 'function' ? value.get() : value
const readOptions = config => Object.fromEntries(Object.entries(DEFAULTS).map(([key, fallback]) => [key, live(config[key]) ?? fallback]))

export function apply(ctx, config = {}) {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'jev_evaluate',
    description: 'Evaluate text or structured data with TypeSafe JEV. Use named Noul (yes/no probability), Choice (classification), and Score (ordered-rubric evaluation) questions, including mixed batches. Returns the actual model, complete answers with probabilities/confidence and token usage. For evaluation and decision tasks; does not generate prose answers. Content in state and questions is sent to TypeSafe. API key comes from DSH credentials.',
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      try {
        exec.signal.throwIfAborted()
        const options = readOptions(config)
        const request = buildRequest(args, options.model)
        const ref = credentialRef(options.apiKeyEnv)
        const credential = await ctx.credentials.resolve(ref)
        exec.signal.throwIfAborted()
        if (!credential?.value?.trim()) {
          throw new JevError(`请打开 DSH 侧边栏「插件」→「dsh-jev」详情，保存 TypeSafe API Key（凭据引用：${options.apiKeyEnv}），然后重试 jev_evaluate。也可向宿主提供同名环境变量。`, 'JEV_MISSING_CREDENTIAL')
        }
        return await evaluateJev(request, { ...options, apiKey: credential.value, signal: exec.signal })
      } catch (error) {
        if (!(error instanceof JevError)) throw error
        // DSH retains structured failure codes only for HarnessError instances.
        const failure = new HarnessError(error.message, error.code)
        failure.name = 'JevError'
        throw failure
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `JEV 评估 · ${Object.keys(args.questions).length} 个问题`,
      kind: 'other',
      rawInput: args,
    }),
  })))
}
