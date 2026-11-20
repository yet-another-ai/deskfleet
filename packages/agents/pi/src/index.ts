/// <reference path="./pi-acp.d.ts" />
import {
  connectAcpProcess, hostedProcess, jsonVersionParser, launchProviderCommand, npmLocations,
  resolveStandardUrlInstaller, type AgentProvider, type AgentProviderPlugin,
} from "@deskfleet/agent-core"
import { parsePiComposerSkill } from "./protocol.ts"

export { parsePiComposerSkill }

export const PI_ACP_ARGUMENT = "--pi-acp"

/** The pinned bridge translates ACP to the installed Pi CLI's RPC mode. */
export async function runPiAdapter(): Promise<void> {
  if (process.argv.includes("--version")) {
    const { default: manifest } = await import("pi-acp/package.json", { with: { type: "json" } })
    console.log(manifest.version)
    return
  }
  await import("pi-acp")
}

export const piProvider: AgentProvider = {
  id: "pi",
  connect(config, client) {
    const host = hostedProcess(PI_ACP_ARGUMENT)
    const env = Object.fromEntries(Object.entries({ ...config.env, ...host.env })
      .map(([key, value]) => [process.platform === "win32" ? key.toUpperCase() : key, value]))
    // Pi's Windows installers provide a command shim; the bridge needs its
    // extension to select cross-spawn instead of Node's native executable path.
    const binary = config.binaryPath || "pi"
    return connectAcpProcess({
      ...host,
      env: { ...env, PI_ACP_PI_COMMAND: process.platform === "win32" && binary === "pi" ? "pi.cmd" : binary },
    }, client)
  },
}

export const piPlugin: AgentProviderPlugin<"pi"> = {
  id: "pi",
  template: { id: "pi", name: "Pi Coding Agent", defaultBinaryPath: "pi" },
  provider: piProvider,
  bundledAdapter: {
    argument: PI_ACP_ARGUMENT,
    run: runPiAdapter,
  },
  parseComposerSkill: parsePiComposerSkill,
  setup: {
    searchDirectories(ctx) {
      return [
        ...npmLocations(ctx),
        ctx.path.join(ctx.env.PI_CODING_AGENT_DIR ?? ctx.path.join(ctx.home, ".pi", "agent"), "bin"),
      ]
    },
    validateBinary(binary, ctx) {
      if (ctx.platform === "win32" && /\.ps1$/iu.test(binary)) {
        return "Select Pi's .cmd launcher or native .exe; its ACP adapter cannot execute PowerShell scripts."
      }
      return undefined
    },
    identityPattern: /\bpi\s+-\s+AI coding assistant\b/iu,
    resolveInstaller: ctx => resolveStandardUrlInstaller(ctx, {
      unixUrl: "https://pi.dev/install.sh",
      unixShell: "sh",
      windowsUrl: "https://pi.dev/install.ps1",
    }),
    resolveLogin(binary, _input, _probeResult, ctx) {
      if (!binary) throw new Error("Install or select the provider executable before signing in.")
      // Pi uses /login in its TUI.
      return launchProviderCommand(binary, [], ctx.env, ctx.platform)
    },
  },
  update: {
    versionSource: () => ({
      url: "https://pi.dev/api/installer/releases/latest",
      parse: jsonVersionParser(),
    }),
  },
}
