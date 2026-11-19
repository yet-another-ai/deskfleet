import { codebuddyProvider as coreCodebuddyProvider } from "@deskfleet/agent-codebuddy"
import { adaptProvider } from "./acp.ts"

export { codebuddyPlugin, codebuddyProcess } from "@deskfleet/agent-codebuddy"

export const codebuddyProvider = adaptProvider(coreCodebuddyProvider)
