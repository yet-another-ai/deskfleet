import { defineAgent, defineDynamic } from "eve"

export default defineAgent({
  model: defineDynamic(() => process.env.DESKFLEET_SUPER_AGENT_MODEL || "openai/gpt-5.4-mini"),
  defaultTools: false,
  limits: { sessionTimeoutMs: false },
  experimental: { workflow: { world: "@workflow/world-postgres", retention: "default" } },
})
