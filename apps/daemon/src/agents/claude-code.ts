import { claudeCodeProvider as coreClaudeCodeProvider } from "@deskfleet/agent-claude-code"
import { adaptProvider } from "./acp.ts"

export { CLAUDE_AGENT_ACP_ARGUMENT, claudeCodePlugin, parseClaudeCodeUsage, runClaudeCodeAdapter } from "@deskfleet/agent-claude-code"

export const claudeCodeProvider = adaptProvider(coreClaudeCodeProvider)
