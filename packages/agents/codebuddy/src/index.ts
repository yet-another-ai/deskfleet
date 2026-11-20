import {
  connectAcpProcess, extractSemverVersion, launchProviderCommand, npmLocations, resolveStandardUrlInstaller,
  type AgentConfig, type AgentProcess, type AgentProvider, type AgentProviderPlugin,
} from "@deskfleet/agent-core"

const CODEBUDDY_COMMAND_TIMEOUT_MS = 10_000
const CODEBUDDY_PROBE_TIMEOUT_MS = 30_000

/** CodeBuddy Code exposes native ACP over stdio and loads its own credentials. */
export function codebuddyProcess(config: AgentConfig): AgentProcess {
  return {
    ...launchProviderCommand(config.binaryPath || "codebuddy", ["--acp"], config.env),
    ...(config.cwd ? { cwd: config.cwd } : {}),
  }
}

export const codebuddyProvider: AgentProvider = {
  id: "codebuddy",
  // Its ACP authenticate method clears cached credentials and starts login.
  // session/new accepts existing credentials; interactive login belongs to setup.
  connect: (config, client) => connectAcpProcess(codebuddyProcess(config), client),
}

export const codebuddyPlugin: AgentProviderPlugin<"codebuddy"> = {
  id: "codebuddy",
  template: { id: "codebuddy", name: "CodeBuddy Code", defaultBinaryPath: "codebuddy" },
  provider: codebuddyProvider,
  setup: {
    probeTimeoutMs: () => CODEBUDDY_PROBE_TIMEOUT_MS,
    // CodeBuddy prints a bare version; its help loads the CLI bundle and can exceed
    // the default three-second command budget on Windows, including npm launchers.
    identityCommandTimeoutMs: CODEBUDDY_COMMAND_TIMEOUT_MS,
    searchDirectories(ctx) {
      const directories = [...npmLocations(ctx)]
      if (ctx.platform !== "win32" && ctx.env.XDG_DATA_HOME) {
        directories.push(ctx.path.join(ctx.env.XDG_DATA_HOME, "..", "bin"))
      }
      if (ctx.platform === "win32") {
        const local = ctx.env.LOCALAPPDATA ?? ctx.path.join(ctx.home, "AppData", "Local")
        directories.push(ctx.path.join(local, "codebuddy", "bin"))
      }
      return directories
    },
    identityPattern: /\bcodebuddy\b/iu,
    resolveInstaller: ctx => resolveStandardUrlInstaller(ctx, {
      unixUrl: "https://copilot.tencent.com/cli/install.sh",
      unixShell: "bash",
      windowsUrl: "https://copilot.tencent.com/cli/install.ps1",
    }),
    resolveLogin(binary, _input, _probeResult, ctx) {
      if (!binary) throw new Error("Install or select the provider executable before signing in.")
      // CodeBuddy uses /login in its TUI.
      return launchProviderCommand(binary, [], ctx.env, ctx.platform)
    },
  },
  update: {
    versionSource: () => ({
      url: "https://acc-1258344699.cos.accelerate.myqcloud.com/@tencent-ai/codebuddy-code/releases/latest",
      parse: body => extractSemverVersion(body),
    }),
  },
}
