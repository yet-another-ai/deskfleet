import { ompProvider as coreOmpProvider } from "@deskfleet/agent-omp"
import { adaptProvider } from "./acp.ts"

export { ompPlugin, parseOmpUsage } from "@deskfleet/agent-omp"

export const ompProvider = adaptProvider(coreOmpProvider)
