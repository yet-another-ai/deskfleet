import { posix, win32 } from "node:path"
import { createInterface } from "node:readline"
import * as acp from "@agentclientprotocol/sdk/unstable"
import { connectAcpProcess, type AgentConfig, type AgentProcess, type AgentProvider } from "./acp.ts"
import { adapterProcess, ANTIGRAVITY_LOGIN_ARGUMENT } from "./adapter-host.ts"
import { launchProviderCommand } from "../provider-setup-process.ts"

/** Google's standalone ACP runtime ships with a matching local harness. */
export function antigravityProcess(config: AgentConfig, platform: NodeJS.Platform = process.platform): AgentProcess {
  const path = platform === "win32" ? win32 : posix
  const binary = config.binaryPath || (platform === "win32" ? "agy_acp_server.exe" : "agy_acp_server.par")
  const harness = /[/\\]/u.test(binary)
    ? { ANTIGRAVITY_HARNESS_PATH: path.resolve(path.dirname(binary), platform === "win32" ? "localharness_external.exe" : "localharness_external") }
    : {}
  // The Linux registry entry disables the runtime's default UID switch.
  return launchProviderCommand(binary, platform === "linux" ? ["--uid="] : [], { ...harness, ...config.env }, platform)
}

export function antigravityLoginProcess(binaryPath: string, env?: NodeJS.ProcessEnv): AgentProcess {
  const host = adapterProcess(ANTIGRAVITY_LOGIN_ARGUMENT)
  return { ...host, env: { ...env, ...host.env, DESKFLEET_ANTIGRAVITY_BINARY: binaryPath } }
}

async function selectLoginMethod(methods: readonly acp.AuthMethod[], signal: AbortSignal): Promise<acp.AuthMethod> {
  if (!methods.length) throw new Error("Antigravity did not advertise any sign-in methods.")
  if (methods.length === 1) return methods[0]!
  process.stdout.write(
    methods.map((item, index) => `  ${index + 1}. ${item.name}${item.description ? ` (${item.description})` : ""}\n`).join("")
    + `Select [1-${methods.length}] (default 1): `,
  )
  const rl = createInterface({ input: process.stdin, output: process.stdout, signal })
  try {
    for await (const line of rl) {
      const choice = line.trim()
      if (!choice) return methods[0]!
      const index = Number(choice) - 1
      if (Number.isInteger(index) && methods[index]) return methods[index]!
      process.stdout.write(`Select [1-${methods.length}] (default 1): `)
    }
  } finally {
    rl.close()
  }
  signal.throwIfAborted()
  throw new Error("Sign-in cancelled.")
}

export async function runAntigravityLogin(): Promise<void> {
  const controller = new AbortController()
  const abort = () => controller.abort(new Error("Sign-in interrupted."))
  process.once("SIGINT", abort)
  process.once("SIGTERM", abort)
  try {
    let agent!: acp.ClientContext
    const connection = await connectAcpProcess(
      antigravityProcess({ name: "Antigravity", binaryPath: process.env.DESKFLEET_ANTIGRAVITY_BINARY }),
      { signal: controller.signal, onUpdate() {} },
      { afterInitialize: async (_init, client) => { agent = client } },
    )
    try {
      const method = await selectLoginMethod(connection.initialization.authMethods ?? [], controller.signal)
      // Clearing saved auth.type and cached OAuth tokens forces a fresh browser sign-in for re-login or account switches.
      if (connection.initialization.agentCapabilities?.auth?.logout) {
        await agent.request(acp.methods.agent.logout, {})
      }
      await agent.request(acp.methods.agent.authenticate, { methodId: method.id })
    } finally {
      await connection.close()
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  } finally {
    process.off("SIGINT", abort)
    process.off("SIGTERM", abort)
  }
}

export const antigravityProvider: AgentProvider = {
  id: "antigravity",
  connect(config, client) {
    return connectAcpProcess(antigravityProcess(config), client)
  },
}
