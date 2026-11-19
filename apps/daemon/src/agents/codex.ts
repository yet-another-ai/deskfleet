import { codexProvider as coreCodexProvider } from "@deskfleet/agent-codex"
import { adaptProvider } from "./acp.ts"

export { CODEX_ACP_ARGUMENT, codexPlugin, parseCodexUsage, runCodexAdapter } from "@deskfleet/agent-codex"

export const codexProvider = adaptProvider(coreCodexProvider)
