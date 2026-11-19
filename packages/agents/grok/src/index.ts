import * as acp from "@agentclientprotocol/sdk/unstable"
import {
  connectAcpProcess, extractSemverVersion, launchProviderCommand, resolveBashScriptInstaller,
  supportsAutoInstallPlatform, UNSUPPORTED_INSTALL_PLATFORM_MESSAGE,
  type AcpExtension, type AgentConfig, type AgentProcess, type AgentProvider, type AgentProviderPlugin,
} from "@deskfleet/agent-core"
import { GROK_SESSION_CONFIG_META_KEY } from "./protocol.ts"
import {
  answerGrokQuestion, GROK_ASK_USER_QUESTION_ALIAS, GROK_ASK_USER_QUESTION_METHOD, grokPlanInterview, grokPlanOutcome,
} from "./questions.ts"

export {
  answerGrokQuestion, GROK_ASK_USER_QUESTION_ALIAS, GROK_ASK_USER_QUESTION_METHOD,
  GROK_SESSION_CONFIG_META_KEY, grokPlanInterview, grokPlanOutcome,
}

/** Grok CLI starts its ACP server with these arguments. */
export const GROK_ACP_ARGUMENTS = ["agent", "stdio"] as const
/** Advertised when `XAI_API_KEY` is available to the CLI. */
export const GROK_API_KEY_METHOD = "xai.api_key"
/** Advertised after `grok login` has cached a session token. */
export const GROK_CACHED_TOKEN_METHOD = "cached_token"

export function grokProcess(config: AgentConfig): AgentProcess {
  return launchProviderCommand(config.binaryPath || "grok", [...GROK_ACP_ARGUMENTS], config.env)
}

function agentAuthMethod(initialization: acp.InitializeResponse, id: string): boolean {
  const method = initialization.authMethods?.find(item => item.id === id)
  return !!method && !("type" in method && method.type === "terminal")
}

/**
 * Completes the handshake from Grok's ACP example.
 * `xai.api_key` wins when that variable is set and the CLI advertises it.
 * Otherwise a cached login is used. Interactive methods such as browser login
 * are not passed to `authenticate`.
 */
export async function authenticateGrok(
  initialization: acp.InitializeResponse,
  agent: acp.ClientContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const methodId = env.XAI_API_KEY && agentAuthMethod(initialization, GROK_API_KEY_METHOD)
    ? GROK_API_KEY_METHOD
    : agentAuthMethod(initialization, GROK_CACHED_TOKEN_METHOD)
      ? GROK_CACHED_TOKEN_METHOD
      : undefined
  if (!methodId) throw new Error("Run `grok login` first, or set XAI_API_KEY.")
  await agent.request(acp.methods.agent.authenticate, { methodId, _meta: { headless: true } })
}

/** Registers Grok's `x.ai/sessionConfig` metadata key and question request handlers on an ACP connection. */
export function createGrokExtension(): AcpExtension {
  return {
    sessionConfigMetaKeys: [GROK_SESSION_CONFIG_META_KEY],
    requestsRequireElicitation: true,
    requests: {
      [GROK_ASK_USER_QUESTION_METHOD]: (params, signal, ctx) => answerGrokQuestion(params, ctx.requestElicitation!, signal),
      [GROK_ASK_USER_QUESTION_ALIAS]: (params, signal, ctx) => answerGrokQuestion(params, ctx.requestElicitation!, signal),
    },
  }
}

/** Launches the installed Grok CLI directly. It speaks ACP; no adapter process is required. */
export const grokProvider: AgentProvider = {
  id: "grok",
  connect(config, client) {
    return connectAcpProcess(grokProcess(config), client, {
      afterInitialize: (initialization, agent) => authenticateGrok(initialization, agent, { ...process.env, ...config.env }),
      extensions: [createGrokExtension()],
    })
  },
}

export const grokPlugin: AgentProviderPlugin<"grok"> = {
  id: "grok",
  template: { id: "grok", name: "Grok", defaultBinaryPath: "grok" },
  provider: grokProvider,
  setup: {
    searchDirectories(ctx) {
      const directories: string[] = []
      if (ctx.env.GROK_BIN_DIR) directories.push(ctx.env.GROK_BIN_DIR)
      directories.push(ctx.path.join(ctx.home, ".grok", "bin"))
      return directories
    },
    identityPattern: /\bgrok\b/iu,
    async resolveInstaller(ctx) {
      if (!supportsAutoInstallPlatform(ctx)) return UNSUPPORTED_INSTALL_PLATFORM_MESSAGE
      // Grok's native Windows installer runs under Git for Windows / MSYS2 Bash, not PowerShell or WSL.
      return resolveBashScriptInstaller(ctx, "curl -fsSL 'https://x.ai/cli/install.sh' | bash", {
        windowsGitBash: true,
        missingMessage: ctx.platform === "win32"
          ? "Git for Windows is required to install Grok."
          : "Bash is required to run the official installer.",
      })
    },
    nonInteractiveInstaller(launch, ctx) {
      // Grok always runs under Bash, never PowerShell, so do not prepend PowerShell flags on win32.
      return { ...launch, env: ctx.env }
    },
    resolveLogin(binary, _input, _probeResult, ctx) {
      if (!binary) throw new Error("Install or select the provider executable before signing in.")
      return launchProviderCommand(binary, ["login", "--device-auth"], ctx.env, ctx.platform)
    },
  },
  update: {
    versionSource: () => ({
      url: "https://x.ai/cli/stable",
      parse: body => extractSemverVersion(body),
    }),
  },
}
