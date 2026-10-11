import { Schema } from "effect"

export interface ProviderPreset {
  readonly id: string
  readonly name: string
  readonly defaultBaseUrl: string
  readonly defaultModel: string
  readonly suggestedModels: ReadonlyArray<string>
  /** Alternate endpoint, e.g. the mainland China region. */
  readonly altBaseUrl?: string
  readonly keyPageUrl?: string
  readonly requiresKey: boolean
}

/** The same OpenAI-compatible APIs the Mac app knows about, plus `custom` for anything else. */
export const providerPresets: ReadonlyArray<ProviderPreset> = [
  {
    id: "deepseek",
    name: "DeepSeek",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    suggestedModels: ["deepseek-chat", "deepseek-reasoner"],
    keyPageUrl: "https://platform.deepseek.com/api_keys",
    requiresKey: true
  },
  {
    id: "openai",
    name: "OpenAI",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4.1-mini",
    suggestedModels: ["gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini"],
    keyPageUrl: "https://platform.openai.com/api-keys",
    requiresKey: true
  },
  {
    id: "qwen",
    name: "Qwen (Alibaba Cloud)",
    defaultBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-plus",
    suggestedModels: ["qwen-max", "qwen-plus", "qwen-turbo", "qwen3-coder-plus"],
    altBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    keyPageUrl: "https://modelstudio.console.alibabacloud.com/",
    requiresKey: true
  },
  {
    id: "kimi",
    name: "Kimi (Moonshot AI)",
    defaultBaseUrl: "https://api.moonshot.ai/v1",
    defaultModel: "kimi-latest",
    suggestedModels: ["kimi-latest", "kimi-k2-turbo-preview", "moonshot-v1-32k"],
    altBaseUrl: "https://api.moonshot.cn/v1",
    keyPageUrl: "https://platform.moonshot.ai/console/api-keys",
    requiresKey: true
  },
  {
    id: "glm",
    name: "GLM (Z.ai / Zhipu)",
    defaultBaseUrl: "https://api.z.ai/api/paas/v4",
    defaultModel: "glm-4.5",
    suggestedModels: ["glm-4.6", "glm-4.5", "glm-4.5-air"],
    altBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    keyPageUrl: "https://z.ai/manage-apikey/apikey-list",
    requiresKey: true
  },
  {
    id: "minimax",
    name: "MiniMax",
    defaultBaseUrl: "https://api.minimax.io/v1",
    defaultModel: "MiniMax-M2",
    suggestedModels: ["MiniMax-M2", "MiniMax-Text-01"],
    altBaseUrl: "https://api.minimaxi.com/v1",
    keyPageUrl: "https://www.minimax.io/platform",
    requiresKey: true
  },
  {
    id: "custom",
    name: "Custom (OpenAI-compatible)",
    defaultBaseUrl: "",
    defaultModel: "",
    suggestedModels: [],
    requiresKey: false
  }
]

export const defaultProviderId = "deepseek"

export const findPreset = (id: string): ProviderPreset | undefined => providerPresets.find((preset) => preset.id === id)

export class ProviderInfo extends Schema.Class<ProviderInfo>("ProviderInfo")({
  id: Schema.String,
  name: Schema.String,
  baseUrl: Schema.String,
  defaultBaseUrl: Schema.String,
  altBaseUrl: Schema.NullOr(Schema.String),
  model: Schema.String,
  defaultModel: Schema.String,
  suggestedModels: Schema.Array(Schema.String),
  keyPageUrl: Schema.NullOr(Schema.String),
  requiresKey: Schema.Boolean,
  /** Keys are write-only; this only says whether one is saved. */
  hasKey: Schema.Boolean,
  isDefault: Schema.Boolean
}) {}

export const ProviderUpdate = Schema.Struct({
  /** Empty resets to the preset's endpoint. */
  baseUrl: Schema.optional(Schema.String),
  /** Empty removes the saved key. */
  apiKey: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  makeDefault: Schema.optional(Schema.Boolean)
})
export type ProviderUpdate = typeof ProviderUpdate.Type

export class ProviderTestResult extends Schema.Class<ProviderTestResult>("ProviderTestResult")({
  ok: Schema.Boolean,
  models: Schema.Array(Schema.String),
  error: Schema.NullOr(Schema.String)
}) {}

export class ProviderNotFound extends Schema.TaggedError<ProviderNotFound>()("ProviderNotFound", {
  id: Schema.String
}, { httpApiStatus: 404 }) {}
