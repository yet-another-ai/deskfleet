import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { defineAgent, defineDynamic } from "eve"

export default defineAgent({
  model: defineDynamic(() => {
    const baseURL = process.env.DESKFLEET_SUPER_AGENT_BASE_URL
    const modelId = process.env.DESKFLEET_SUPER_AGENT_MODEL?.trim()
    if (!baseURL) return modelId || "openai/gpt-5.4-mini"
    if (!modelId) throw new Error("Set DESKFLEET_SUPER_AGENT_MODEL when using DESKFLEET_SUPER_AGENT_BASE_URL")

    const model = createOpenAICompatible({
      name: "openai-compatible",
      baseURL,
      apiKey: process.env.DESKFLEET_SUPER_AGENT_API_KEY,
      includeUsage: true,
    })(modelId)
    const contextWindow = process.env.DESKFLEET_SUPER_AGENT_CONTEXT_WINDOW_TOKENS
    if (contextWindow === undefined) return model
    const modelContextWindowTokens = Number(contextWindow)
    if (!Number.isSafeInteger(modelContextWindowTokens) || modelContextWindowTokens <= 0) {
      throw new Error("DESKFLEET_SUPER_AGENT_CONTEXT_WINDOW_TOKENS must be a positive safe integer")
    }
    return { model, modelContextWindowTokens }
  }),
  defaultTools: false,
  limits: { sessionTimeoutMs: false },
  experimental: { workflow: { world: "@workflow/world-postgres", retention: "default" } },
})
