import { deepseekHarnessProvider as coreDeepseekHarnessProvider } from "@deskfleet/agent-deepseek-harness"
import { adaptProvider } from "./acp.ts"

export {
  DEEPSEEK_HARNESS_ACP_ARGUMENTS, deepseekHarnessPlugin, deepseekHarnessProcess,
} from "@deskfleet/agent-deepseek-harness"

export const deepseekHarnessProvider = adaptProvider(coreDeepseekHarnessProvider)
