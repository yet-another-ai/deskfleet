import { grokProvider as coreGrokProvider } from "@deskfleet/agent-grok"
import { adaptProvider } from "./acp.ts"

export {
  authenticateGrok, createGrokExtension, GROK_ACP_ARGUMENTS, GROK_API_KEY_METHOD, GROK_CACHED_TOKEN_METHOD,
  grokPlugin, grokProcess,
} from "@deskfleet/agent-grok"

export const grokProvider = adaptProvider(coreGrokProvider)
