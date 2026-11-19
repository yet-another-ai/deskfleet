import {
  canContinueSession, connectAcpProcess as coreConnectAcpProcess, supportsSteering,
  type AcpConnectOptions, type AcpExtension, type AgentClient as CoreAgentClient, type AgentConfig,
  type AgentConnection, type AgentProcess, type AgentProvider as CoreAgentProvider, type AgentTerminalHandler,
  type SteeringOutcome,
} from "@deskfleet/agent-core"
import { CursorNotifications, CURSOR_NOTIFICATION_METHODS } from "./cursor-notifications.ts"
import { answerCursorCreatePlan, VENDOR_PLAN_METHODS } from "./plans.ts"
import { answerVendorQuestion, VENDOR_QUESTION_METHODS } from "./questions.ts"
import { createAgentTerminalHandler, isAgentTerminalHandler, type AgentTerminalContext } from "./terminals.ts"

export { canContinueSession, supportsSteering }
export type { AcpConnectOptions, AcpExtension, AgentConfig, AgentConnection, AgentProcess, SteeringOutcome }

export interface AgentClient extends Omit<CoreAgentClient, "terminals"> {
  terminals?: AgentTerminalContext
}

export interface AgentProvider extends Omit<CoreAgentProvider, "connect"> {
  connect(config: AgentConfig, client: AgentClient): Promise<AgentConnection>
}

export function normalizeAgentClient(client: AgentClient): CoreAgentClient {
  const { terminals, ...rest } = client
  if (!terminals) return rest
  return {
    ...rest,
    terminals: isAgentTerminalHandler(terminals) ? terminals : createAgentTerminalHandler(terminals),
  }
}

function legacyVendorExtension(): AcpExtension {
  const cursor = new CursorNotifications()
  return {
    sessionConfigMetaKeys: ["x.ai/sessionConfig"],
    notifications: Object.fromEntries(CURSOR_NOTIFICATION_METHODS.map(method => [
      method,
      async (params, ctx) => {
        const sessionId = ctx.getSessionId()
        if (!sessionId || method === "cursor/update_todos" && !ctx.capabilities?.plans) return
        const notification = cursor.update(method, params, sessionId, ctx.cwd)
        if (notification) await ctx.onUpdate(notification)
      },
    ])),
    requestsRequireElicitation: true,
    requests: {
      ...Object.fromEntries(VENDOR_QUESTION_METHODS.map(method => [
        method,
        (params, signal, ctx) => answerVendorQuestion(method, params, ctx.getSessionId(), ctx.requestElicitation!, signal),
      ])),
      ...Object.fromEntries(VENDOR_PLAN_METHODS.map(method => [
        method,
        (params, signal, ctx) => answerCursorCreatePlan(params, ctx.getSessionId(), ctx.requestElicitation!, signal),
      ])),
    },
  }
}

export function adaptProvider(provider: CoreAgentProvider): AgentProvider {
  return {
    id: provider.id,
    connect: (config, client) => provider.connect(config, normalizeAgentClient(client)),
    ...(provider.readUsage ? { readUsage: (config, signal) => provider.readUsage!(config, signal) } : {}),
  }
}

export function connectAcpProcess(launch: AgentProcess, client: AgentClient, options: AcpConnectOptions = {}): Promise<AgentConnection> {
  return coreConnectAcpProcess(launch, normalizeAgentClient(client), {
    ...options,
    extensions: [legacyVendorExtension(), ...(options.extensions ?? [])],
  })
}
