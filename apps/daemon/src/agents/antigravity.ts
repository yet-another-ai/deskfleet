import { antigravityProvider as coreAntigravityProvider } from "@deskfleet/agent-antigravity"
import { adaptProvider } from "./acp.ts"

export {
  antigravityPlugin, parseAntigravityUsage, wrapAntigravityConnection,
} from "@deskfleet/agent-antigravity"

export const antigravityProvider = adaptProvider(coreAntigravityProvider)
