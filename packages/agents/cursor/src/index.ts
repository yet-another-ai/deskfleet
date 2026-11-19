import * as acp from "@agentclientprotocol/sdk/unstable"
import {
  connectAcpProcess, extractSemverVersion, launchProviderCommand, resolveStandardUrlInstaller,
  type AcpExtension, type AgentConfig, type AgentProcess, type AgentProvider, type AgentProviderPlugin,
} from "@deskfleet/agent-core"
import { CURSOR_NOTIFICATION_METHODS, CursorNotifications } from "./notifications.ts"
import { answerCursorCreatePlan, CURSOR_CREATE_PLAN_METHOD, cursorPlanApproval, type CursorPlanApproval, type CursorPlanTodo } from "./plans.ts"
import { answerCursorQuestion, CURSOR_ASK_QUESTION_METHOD } from "./questions.ts"

export {
  answerCursorCreatePlan, answerCursorQuestion, CURSOR_ASK_QUESTION_METHOD, CURSOR_CREATE_PLAN_METHOD,
  CURSOR_NOTIFICATION_METHODS, CursorNotifications, cursorPlanApproval, type CursorPlanApproval, type CursorPlanTodo,
}

/** Cursor CLI starts its ACP server with this subcommand. Root flags, when used, must precede it. */
export const CURSOR_ACP_ARGUMENT = "acp"
/** Auth method Cursor advertises during ACP initialization. */
export const CURSOR_AUTH_METHOD = "cursor_login"

const CURSOR_VERSION = /(?:^|[^0-9A-Za-z.])(\d{4}\.\d{1,2}\.\d{1,2}-[0-9A-Za-z._-]+)(?![0-9A-Za-z._-])/u
const CURSOR_DOWNLOAD_VERSION = /downloads\.cursor\.com\/(?:lab|versions)\/(\d{4}\.\d{1,2}\.\d{1,2}-[0-9A-Za-z._-]+)/u
const CURSOR_WINDOWS_VERSION = /\$version\s*=\s*['"](\d{4}\.\d{1,2}\.\d{1,2}-[0-9A-Za-z._-]+)['"]/u
const VERSION_COLLATOR = new Intl.Collator("en", { numeric: true, sensitivity: "base" })

export function cursorProcess(config: AgentConfig): AgentProcess {
  // Cursor ACP reads project skills, rules, and subagents from this process
  // directory. The session/new cwd selects file tools and does not replace it.
  return {
    ...launchProviderCommand(config.binaryPath || "agent", [CURSOR_ACP_ARGUMENT], config.env),
    ...(config.cwd ? { cwd: config.cwd } : {}),
  }
}

/**
 * Completes Cursor's documented handshake when it advertises `cursor_login`.
 * Terminal auth is a separate interactive program and is not passed to `authenticate`.
 * A missing method means the CLI did not ask for this login step.
 */
export async function authenticateCursor(initialization: acp.InitializeResponse, agent: acp.ClientContext): Promise<void> {
  const method = initialization.authMethods?.find(item => item.id === CURSOR_AUTH_METHOD)
  if (!method || ("type" in method && method.type === "terminal")) return
  await agent.request(acp.methods.agent.authenticate, { methodId: CURSOR_AUTH_METHOD })
}

/** Registers Cursor's vendor notifications (`cursor/*`), plan approval, and question requests on an ACP connection. */
export function createCursorExtension(): AcpExtension {
  const notifications = new CursorNotifications()
  return {
    notifications: Object.fromEntries(CURSOR_NOTIFICATION_METHODS.map(method => [
      method,
      async (params, ctx) => {
        const sessionId = ctx.getSessionId()
        if (!sessionId || method === "cursor/update_todos" && !ctx.capabilities?.plans) return
        const notification = notifications.update(method, params, sessionId, ctx.cwd)
        if (notification) await ctx.onUpdate(notification)
      },
    ])),
    requestsRequireElicitation: true,
    requests: {
      [CURSOR_ASK_QUESTION_METHOD]: (params, signal, ctx) =>
        answerCursorQuestion(params, ctx.getSessionId(), ctx.requestElicitation!, signal),
      [CURSOR_CREATE_PLAN_METHOD]: (params, signal, ctx) =>
        answerCursorCreatePlan(params, ctx.getSessionId(), ctx.requestElicitation!, signal),
    },
  }
}

/** Launches the installed Cursor CLI directly. It speaks ACP; no adapter process is required. */
export const cursorProvider: AgentProvider = {
  id: "cursor",
  connect(config, client) {
    // cursor_login starts browser auth when credentials have expired. Cursor's
    // session/new also accepts credentials loaded at startup, without that call.
    return connectAcpProcess(cursorProcess(config), client, {
      ...(config.authentication === "existing" ? {} : { afterInitialize: authenticateCursor }),
      // Without this, Cursor folds reasoning into one variant id per model and advertises no effort control.
      clientCapabilities: { _meta: { parameterizedModelPicker: true } },
      extensions: [createCursorExtension()],
    })
  },
}

function splitCursorDate(version: string): string {
  const dash = version.indexOf("-")
  return dash < 0 ? version : version.slice(0, dash)
}

export const cursorPlugin: AgentProviderPlugin<"cursor"> = {
  id: "cursor",
  template: { id: "cursor", name: "Cursor", defaultBinaryPath: "agent" },
  provider: cursorProvider,
  setup: {
    defaultCommands: ["cursor-agent", "agent"],
    searchDirectories(ctx) {
      if (ctx.platform !== "win32") return []
      const local = ctx.env.LOCALAPPDATA ?? ctx.path.join(ctx.home, "AppData", "Local")
      return [ctx.path.join(local, "cursor-agent")]
    },
    identityPattern: /\bcursor\b/iu,
    async checkAuth(binary, ctx) {
      try {
        const result = await ctx.run(binary, ["status", "--format", "json"], ctx.env, ctx.home)
        const value: unknown = JSON.parse(result.stdout)
        if (value && typeof value === "object") {
          const loggedIn = (value as { isAuthenticated?: unknown }).isAuthenticated
          if (typeof loggedIn === "boolean") return loggedIn ? "authenticated" : "unauthenticated"
        }
      } catch { /* Old CLIs and unavailable status endpoints cannot establish authentication. */ }
      return "unknown"
    },
    resolveInstaller: ctx => resolveStandardUrlInstaller(ctx, {
      unixUrl: "https://cursor.com/install",
      unixShell: "bash",
      windowsUrl: "https://cursor.com/install?win32=true",
    }),
    resolveLogin(binary, _input, _probeResult, ctx) {
      if (!binary) throw new Error("Install or select the provider executable before signing in.")
      return launchProviderCommand(binary, ["login"], { ...ctx.env, NO_OPEN_BROWSER: "1" }, ctx.platform)
    },
  },
  update: {
    versionSource: platform => ({
      url: platform === "win32" ? "https://cursor.com/install?win32=true" : "https://cursor.com/install",
      parse: body => CURSOR_DOWNLOAD_VERSION.exec(body)?.[1] ?? CURSOR_WINDOWS_VERSION.exec(body)?.[1],
    }),
    extractVersion(cleaned) {
      return CURSOR_VERSION.exec(cleaned)?.[1] ?? extractSemverVersion(cleaned)
    },
    compareVersions(current, latest) {
      return VERSION_COLLATOR.compare(splitCursorDate(current), splitCursorDate(latest))
    },
    isVersionNewer(current, latest) {
      if (current === latest) return false
      const diff = VERSION_COLLATOR.compare(splitCursorDate(current), splitCursorDate(latest))
      // Cursor builds share a date and differ only by commit hash.
      return diff <= 0
    },
  },
}
