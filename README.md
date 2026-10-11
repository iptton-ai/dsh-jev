# dsh-jev

给 DeepSeek Harness 添加 `jev_evaluate` 工具，调用 [TypeSafe JEV](https://docs.typesafe.ai/introduction) 对文本或 JSON 数据做结构化评估。一次请求可以混合多个 Noul、Choice 和 Score 问题，返回原始答案、概率分布、置信度和 token 用量。

已验证宿主：DSH `0.2.0-rc.2`，Node.js 22。直接使用 HTTP API，无 TypeSafe SDK 或运行时普通依赖。核心 DSH 包声明为 optional peer，由宿主提供，避免插件安装拉入另一套核心包。

## 安装

在 DSH 的插件管理页面安装 bundle，包地址填写：

```text
https://github.com/iptton-ai/dsh-jev/archive/refs/heads/main.tar.gz
```

也可以从 [GitHub 仓库](https://github.com/iptton-ai/dsh-jev) 克隆到本地，并使用本地链接安装：

```bash
git clone https://github.com/iptton-ai/dsh-jev.git
```

```text
link:/absolute/path/to/dsh-jev
```

保持 bundle 启用。它通过 [cordis.patch.yml](./cordis.patch.yml) 插入 `id: jev`、`name: dsh-jev` 的宿主插件，注册 `jev_evaluate`。安装和启用会作用于当前 profile 的所有会话；live profile 即时应用，startup profile 需由宿主重启生效。

如果开发环境直接从工作区加载插件，且无法解析宿主包，可执行：

```bash
node scripts/link-host.mjs
```

脚本为四个裸导入创建到现有宿主包的符号链接，不安装、复制或覆盖核心依赖。默认查找 `~/.local/lib/node_modules/@deepseek-ai/dsh/node_modules`；可传入另一个宿主 `node_modules` 的绝对路径。该脚本按已测试的 `0.2.0-rc.2` 校验 DSH 包版本；升级后请先核对契约再调整。

## 配置 API Key

在 DSH 设置的 **jev** 插件配置中，`apiKeyEnv` 默认是 `TYPESAFE_API_KEY`。通过该配置项的凭据控件保存 TypeSafe API Key，或让宿主的凭据服务从同名环境变量读取。凭据服务也支持宿主已加载的项目/用户 `.env` 回退；已有进程未必能读到后来设置的 shell 环境变量，优先使用 DSH 凭据控件。

这里填写的是凭据引用名称，实际 API Key 不放进工具参数或 bundle 配置。插件每次调用重新读取凭据和配置，凭据更新后无须重新注册工具。

| 配置项 | 默认值 | 含义 |
| --- | --- | --- |
| `apiKeyEnv` | `TYPESAFE_API_KEY` | DSH 凭据引用名称，可换成其他合法名称 |
| `baseURL` | `https://api.typesafe.ai` | API 根地址，插件追加 `/v1/systemone`；支持 HTTPS 或本机 loopback HTTP |
| `model` | `jev-latest` | 默认模型，可由本次工具参数覆盖 |
| `timeoutMs` | `60000` | 总超时（毫秒），范围 1000–600000，包含网络、响应读取及重试等待 |
| `maxRetries` | `2` | 收到 429/529 后的重试次数，范围 0–5；最多发送 `maxRetries + 1` 次 |

工具会将 `state`、`questions` 和模型名称发送到配置的 API 地址。自定义网关也会收到 API Key。

## 调用

可以直接让 DSH 助手使用工具，例如：

> 使用 jev_evaluate 分析这条客户消息：收款连续三天失败，今天必须处理好。判断是否紧急、应该分派到哪个团队，并按“平静/不满/非常愤怒”评估情绪；把完整概率结果返回给我。

工具参数只有三个字段：

- `state`（必填）：文本、JSON 对象或数组，例如客户消息、记录或对话历史。
- `questions`（必填）：以你指定的问题 ID 为键的非空对象。
- `model`（可选）：覆盖插件默认模型；使用 TypeSafe 的模型 ID 或别名。

各问题都需要 `type` 和 `instructions`；`instructions` 可以是文本、JSON 对象或数组。

| 类型 | `criteria` | 返回 |
| --- | --- | --- |
| `noul` | 可省略；可用 `{"true":"是的含义","false":"否的含义"}` 提供描述 | `noul`：0–1 的“是”概率 |
| `choice` | 必填；选项名称到描述的对象，1–255 个选项 | `choice`、每个选项的 `probabilities`、`confidence` |
| `score` | 必填；按等级顺序排列的数组，2–10 个等级 | `score`、`legend`、各等级的 `probabilities`、`confidence` |

Choice 描述可以是字符串、对象、数组或 `null`。Score 使用从 0 开始的等级索引，结果是概率加权分数，可为小数；数组 `['平静','不满','非常愤怒']` 的分数范围为 0–2。SDK 也允许 Score/Noul 的空描述，插件保留这一支持。

混合调用示例（完整参数另见 [examples/support-triage.json](./examples/support-triage.json)）：

```json
{
  "state": "我的收款已经连续三天失败了，今天必须处理好，否则客户都要退款！",
  "questions": {
    "is_urgent": {
      "type": "noul",
      "instructions": "是否需要优先处理？"
    },
    "department": {
      "type": "choice",
      "instructions": "哪个团队应处理？",
      "criteria": {
        "billing": "支付、收款、退款",
        "technical": "系统故障、集成错误"
      }
    },
    "frustration": {
      "type": "score",
      "instructions": "客户的情绪有多强烈？",
      "criteria": ["平静", "不满", "非常愤怒"]
    }
  }
}
```

结果形状如下；这些值仅用于说明，不是真实在线评估：

```json
{
  "model": "jev-1.13.0",
  "answers": {
    "is_urgent": {"type": "noul", "noul": 0.95},
    "department": {
      "type": "choice",
      "choice": "billing",
      "probabilities": {"billing": 0.88, "technical": 0.12},
      "confidence": 0.81
    },
    "frustration": {
      "type": "score",
      "score": 1.05,
      "legend": {"0": "平静", "1": "不满", "2": "非常愤怒"},
      "probabilities": {"0": 0.0, "1": 0.95, "2": 0.05},
      "confidence": 0.92
    }
  },
  "usage": {"input_tokens": 304, "output_tokens": 52}
}
```

模型通常将 `jev-latest` 解析到具体版本；若需要结果复现，使用 [TypeSafe 模型页](https://docs.typesafe.ai/models) 中的固定版本。JEV 的公开接口接受文本/结构化内容；输入预算以服务端 tokenizer 为准，插件不估算 token。

## 错误与取消

输入错误会在读取凭据和请求前被拒绝。缺少凭据会提示具体引用名称。HTTP 401/403、422 等响应会报告状态和服务端错误详情；错误文本会屏蔽本次 API Key。工具执行结果保留结构化错误码，如 `JEV_INVALID_ARGUMENTS`、`JEV_MISSING_CREDENTIAL`、`JEV_HTTP_ERROR`、`JEV_INVALID_RESPONSE`、`JEV_NETWORK_ERROR`、`JEV_TIMEOUT` 和 `JEV_CANCELLED`；已取消的调用也会遵循 DSH 执行管道的取消语义。

仅重试明确的 HTTP 429/529，优先遵循 `Retry-After`，否则采用带抖动的指数退避。网络中断及其他 HTTP 错误直接报告给调用者。总超时会中断正在读取的响应或重试等待，DSH 取消信号也会传入 fetch。响应会校验问题 ID、类型、概率范围、Score 范围和 token 用量，校验成功后保留完整 JSON。

请求使用 `accept-encoding: identity`，兼容 DSH 自定义代理 dispatcher 的响应解压行为。HTTP 重定向会作为连接失败报告。

## 开发与验证

```bash
node scripts/link-host.mjs
npm run check
npm test
npm pack --dry-run
```

50 项测试使用当前宿主的 `defineTool`、`ToolRuntime`、schemastery 和兼容性检查，并通过本地 HTTP 服务验证真正的 fetch 请求；覆盖混合问题、限流重试（含超长 `Retry-After`）、超时/取消、结构化错误码、错误密钥屏蔽及配置/凭据轮换。测试不使用 TypeSafe API Key，也不消耗在线额度。

资料：[TypeSafe 入门](https://docs.typesafe.ai/introduction)、[API 参考](https://docs.typesafe.ai/api)、[JavaScript SDK](https://docs.typesafe.ai/sdk/javascript)。
