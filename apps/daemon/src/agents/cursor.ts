import { cursorProvider as coreCursorProvider } from "@deskfleet/agent-cursor"
import { adaptProvider } from "./acp.ts"

export {
  authenticateCursor, createCursorExtension, CURSOR_ACP_ARGUMENT, CURSOR_AUTH_METHOD, cursorPlugin, cursorProcess,
} from "@deskfleet/agent-cursor"

export const cursorProvider = adaptProvider(coreCursorProvider)
