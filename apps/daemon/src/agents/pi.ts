import { piProvider as corePiProvider } from "@deskfleet/agent-pi"
import { adaptProvider } from "./acp.ts"

export { PI_ACP_ARGUMENT, piPlugin, runPiAdapter } from "@deskfleet/agent-pi"

export const piProvider = adaptProvider(corePiProvider)
