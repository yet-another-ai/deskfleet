import { resolve } from "node:path"
import { parseArgs } from "node:util"
import type { AgentConfig, AgentConnection, AgentProvider } from "./agents/acp.ts"
import { claudeCodeProvider } from "./agents/claude-code.ts"
import { codexProvider } from "./agents/codex.ts"
import { cursorProvider } from "./agents/cursor.ts"
import { grokProvider } from "./agents/grok.ts"
import { piProvider } from "./agents/pi.ts"
import type { ManagedWorkspaceSession } from "./session-worktrees.ts"

export interface AgentWorkspaceSessions {
  create(workspaceId: string): Promise<ManagedWorkspaceSession>
  destroy(sessionId: string): Promise<void>
  close(): void
}

const agents: Record<string, { provider: AgentProvider; name: string }> = {
  codex: { provider: codexProvider, name: "Codex" },
  "claude-code": { provider: claudeCodeProvider, name: "Claude Code" },
  cursor: { provider: cursorProvider, name: "Cursor" },
  grok: { provider: grokProvider, name: "Grok" },
  pi: { provider: piProvider, name: "Pi Coding Agent" },
}

export async function runAgent(args: string[], dependencies: {
  provider?: AgentProvider
  workspaceSessions?: () => Promise<AgentWorkspaceSessions>
} = {}) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      check: { type: "boolean" },
      cwd: { type: "string" },
      "workspace-id": { type: "string" },
      prompt: { type: "string" },
      name: { type: "string" },
      "binary-path": { type: "string" },
      env: { type: "string", multiple: true, default: [] },
    },
  })
  if (values.help) {
    console.log("Usage: deskfleet-daemon agent <codex|claude-code|cursor|grok|pi> [--check | --prompt <text>] [--cwd <directory>] [--name <name>] [--binary-path <executable>] [--env KEY=value ...]")
    return
  }
  const selected = positionals.length === 1 && Object.hasOwn(agents, positionals[0]!) ? agents[positionals[0]!] : undefined
  if (!selected) throw new Error(`supported agents: ${Object.keys(agents).join(", ")}`)
  if (values.check ? values.prompt !== undefined : !values.prompt) {
    throw new Error("choose --check or --prompt <text>")
  }
  if (values.cwd !== undefined && values["workspace-id"] !== undefined) {
    throw new Error("--cwd and --workspace-id are mutually exclusive")
  }
  if (values["workspace-id"] !== undefined && !dependencies.workspaceSessions) {
    throw new Error("Manage team Sessions through the authenticated Web or Electron client")
  }

  const config: AgentConfig = {
    name: values.name ?? selected.name,
    binaryPath: values["binary-path"],
    env: Object.fromEntries(values.env.map(value => {
      const separator = value.indexOf("=")
      if (separator < 1) throw new Error("--env must be KEY=value")
      return [value.slice(0, separator), value.slice(separator + 1)]
    })),
  }
  const provider = dependencies.provider ?? selected.provider
  let agent: AgentConnection | undefined
  let workspaceSessions: AgentWorkspaceSessions | undefined
  let managed: ManagedWorkspaceSession | undefined
  let sessionId: string | undefined
  let interrupted = false
  const interrupt = () => {
    interrupted = true
    process.off("SIGINT", interrupt)
    process.off("SIGTERM", interrupt)
    if (!agent) return
    const stopping = sessionId ? agent.cancel(sessionId) : agent.close()
    void stopping.catch(error => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
      void agent?.close()
    })
  }
  process.once("SIGINT", interrupt)
  process.once("SIGTERM", interrupt)
  try {
    if (values["workspace-id"] !== undefined && !values.check) {
      workspaceSessions = await dependencies.workspaceSessions!()
      if (interrupted) return
      managed = await workspaceSessions.create(values["workspace-id"])
      if (interrupted) return
      console.log(JSON.stringify({ event: "workspace_session", ...managed }))
    }
    agent = await provider.connect(config, {
      onUpdate: notification => console.log(JSON.stringify({ event: "session_update", ...notification })),
      requestPermission: async request => {
        console.log(JSON.stringify({ event: "permission_cancelled", ...request }))
        return { outcome: { outcome: "cancelled" } }
      },
    })
    if (interrupted) return
    console.log(JSON.stringify({ event: "initialized", provider: provider.id, name: config.name, ...agent.initialization }))
    if (values.check) return

    const session = await agent.newSession({
      cwd: managed?.worktree.directories[0]?.path ?? resolve(values.cwd ?? process.cwd()),
      ...(managed ? { additionalDirectories: managed.worktree.directories.slice(1).map(directory => directory.path) } : {}),
      mcpServers: [],
    })
    if (interrupted) return
    sessionId = session.sessionId
    console.log(JSON.stringify({ event: "session", provider: provider.id, name: config.name, ...session }))
    const result = await agent.prompt({
      sessionId,
      prompt: [{ type: "text", text: values.prompt! }],
    })
    console.log(JSON.stringify({ event: "stop", sessionId, ...result }))
  } finally {
    process.off("SIGINT", interrupt)
    process.off("SIGTERM", interrupt)
    try {
      // The prompt ending does not itself destroy the checkout: first await
      // actual provider process shutdown, including on initialization failures.
      await agent?.close()
      if (managed) await workspaceSessions!.destroy(managed.id)
    } finally { workspaceSessions?.close() }
  }
}
