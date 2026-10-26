import { spawn } from "node:child_process"
import { Readable, Writable } from "node:stream"
import * as acp from "@agentclientprotocol/sdk"
import { answerCursorCreatePlan, VENDOR_PLAN_METHODS } from "./plans.ts"
import { answerVendorQuestion, VENDOR_QUESTION_METHODS } from "./questions.ts"
import { AcpModelReasoning } from "./reasoning-effort.ts"
import { AcpSessionModes } from "./session-modes.ts"

export interface AgentConfig {
  name: string
  binaryPath?: string
  env?: Record<string, string>
  /** Connection checks may consume existing credentials but must never start login. */
  authentication?: "existing"
}

export interface AgentProvider {
  readonly id: string
  connect(config: AgentConfig, client: AgentClient): Promise<AgentConnection>
}

export interface AgentProcess {
  command: string
  args?: string[]
  env?: NodeJS.ProcessEnv
}

export interface AgentClient {
  signal?: AbortSignal
  onUpdate(notification: acp.SessionNotification): void | Promise<void>
  onClose?(reason: Error): void
  requestPermission?(
    params: acp.RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<acp.RequestPermissionResponse>
  requestElicitation?(
    params: acp.CreateElicitationRequest,
    signal: AbortSignal,
  ): Promise<acp.CreateElicitationResponse>
}

export interface AgentConnection {
  readonly initialization: acp.InitializeResponse
  newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse>
  /** knownOptions restores setter identity after resume; it is never sent over ACP. */
  setConfigOption(params: acp.SetSessionConfigOptionRequest, knownOptions?: acp.SessionConfigOption[]): Promise<acp.SetSessionConfigOptionResponse>
  resume(params: acp.ResumeSessionRequest): Promise<acp.ResumeSessionResponse>
  prompt(params: acp.PromptRequest): Promise<acp.PromptResponse>
  /** Never starts a detached provider turn. Inactive inputs need a normal prompt. */
  steer(params: acp.PromptRequest, deliveryId: string): Promise<SteeringOutcome>
  cancel(sessionId: string): Promise<void>
  close(): Promise<void>
}

export type SteeringOutcome = { outcome: "injected" | "inactive" }

export function supportsSteering(initialization: acp.InitializeResponse): boolean {
  const steering = initialization._meta?.steering
  return typeof steering === "object" && steering !== null
    && "supported" in steering && steering.supported === true
    && "supportsPromptRequired" in steering && steering.supportsPromptRequired === true
}

/** A saved conversation can continue through `session/resume` or, when that is absent, `session/load`. */
export function canContinueSession(initialization: acp.InitializeResponse): boolean {
  const capabilities = initialization.agentCapabilities
  return !!capabilities?.sessionCapabilities?.resume || capabilities?.loadSession === true
}

export interface AcpConnectOptions {
  /** Runs after version negotiation, before callers can create a session. */
  afterInitialize?(initialization: acp.InitializeResponse, agent: acp.ClientContext): Promise<void>
  /** Merged into initialize `clientCapabilities`. Elicitation is added when the client handles forms. */
  clientCapabilities?: acp.ClientCapabilities
}

function choiceValues(option: acp.SessionConfigOption | undefined): string[] {
  if (!option || option.type !== "select") return []
  return option.options.flatMap(value => "group" in value ? value.options : [value]).map(value => value.value)
}

function withModelValue(options: acp.SessionConfigOption[], modelId: string): acp.SessionConfigOption[] {
  return options.map(option => option.type === "select" && (option.category === "model" || option.id === "model")
    ? { ...option, currentValue: modelId } : option)
}

export async function connectAcpProcess(launch: AgentProcess, client: AgentClient, options: AcpConnectOptions = {}): Promise<AgentConnection> {
  client.signal?.throwIfAborted()
  let replayingHistory = false
  const sessionModes = new AcpSessionModes()
  const reasoning = new AcpModelReasoning()
  const child = spawn(launch.command, launch.args ?? [], {
    env: Object.fromEntries(
      [...Object.entries(process.env), ...Object.entries(launch.env ?? {})]
        .map(([key, value]) => [process.platform === "win32" ? key.toUpperCase() : key, value]),
    ),
    stdio: ["pipe", "pipe", "inherit"],
  })
  const exited = new Promise<void>(resolve => child.once("close", () => resolve()))
  let providerSessionId: string | undefined
  const rememberSession = (sessionId: string | undefined) => { if (sessionId) providerSessionId = sessionId }
  let clientApp = acp.client({ name: "deskfleet" })
    .onNotification(acp.methods.client.session.update, async ({ params }) => {
      // session/load replays history before its response. This handler runs
      // synchronously when that notification is read, so the flag still covers
      // the replay and is clear before any later notification is read.
      if (replayingHistory && params.update.sessionUpdate !== "config_option_update" && params.update.sessionUpdate !== "current_mode_update") return
      try {
        const notified = sessionModes.notification(params)
        if (notified.update.sessionUpdate !== "config_option_update") {
          await client.onUpdate(notified)
        } else {
          const projected = reasoning.project({ configOptions: notified.update.configOptions })
          await client.onUpdate(projected.configOptions === notified.update.configOptions ? notified : {
            ...notified,
            update: { sessionUpdate: "config_option_update", configOptions: projected.configOptions ?? [] },
          })
        }
      } catch (error) {
        connection.close(error)
      }
    })
    .onRequest(acp.methods.client.session.requestPermission, async ({ params, signal }) => {
      if (!client.requestPermission) return { outcome: { outcome: "cancelled" } }
      try {
        return await client.requestPermission(params, signal)
      } catch (error) {
        connection.close(error)
        throw error
      }
    })
    .onRequest(acp.methods.client.elicitation.create, async ({ params, signal }) => {
      if (!client.requestElicitation || !acp.CreateElicitationRequest.isForm(params) || !("sessionId" in params)) return { action: "cancel" }
      try {
        return await client.requestElicitation(params, signal)
      } catch (error) {
        connection.close(error)
        throw error
      }
    })
  if (client.requestElicitation) {
    const requestElicitation = client.requestElicitation
    for (const method of VENDOR_QUESTION_METHODS) {
      clientApp = clientApp.onRequest(method, (params: unknown) => params, async ({ params, signal }) => {
        try {
          return await answerVendorQuestion(method, params, providerSessionId, requestElicitation, signal)
        } catch (error) {
          connection.close(error)
          throw error
        }
      })
    }
    for (const method of VENDOR_PLAN_METHODS) {
      clientApp = clientApp.onRequest(method, (params: unknown) => params, async ({ params, signal }) => {
        try {
          return await answerCursorCreatePlan(params, providerSessionId, requestElicitation, signal)
        } catch (error) {
          connection.close(error)
          throw error
        }
      })
    }
  }
  const connection = clientApp.connect(acp.ndJsonStream(
    Writable.toWeb(child.stdin!),
    Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
  ))

  child.once("error", error => {
    connection.close(new Error(`Could not start ${launch.command}: ${error.message}`, { cause: error }))
  })
  child.once("exit", (code, signal) => {
    connection.close(new Error(`ACP process exited (${signal ?? code})`))
  })

  let closing: Promise<void> | undefined
  function close(): Promise<void> {
    if (closing) return closing
    client.signal?.removeEventListener("abort", abort)
    child.stdin!.end()
    connection.close()
    // Give adapters time to stop their own agent subprocesses after stdin EOF.
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000)
    timeout.unref()
    closing = exited.finally(() => clearTimeout(timeout))
    return closing
  }
  const abort = () => { connection.close(client.signal?.reason); void close() }
  client.signal?.addEventListener("abort", abort, { once: true })
  if (client.signal?.aborted) abort()
  void connection.closed.then(() => {
    const reason: unknown = connection.signal.reason
    try {
      client.onClose?.(reason instanceof Error ? reason : new Error("ACP connection closed", { cause: reason }))
    } finally {
      void close()
    }
  }).catch(error => console.error("ACP close callback failed", error))

  const timeout = setTimeout(() => {
    connection.close(new Error(`${launch.command} ACP initialization timed out`))
  }, 15_000)
  timeout.unref()
  try {
    const initialization = await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: { name: "deskfleet", version: "0.1.0" },
      clientCapabilities: {
        ...options.clientCapabilities,
        ...(client.requestElicitation ? { elicitation: { form: {} } } : {}),
      },
    })
    if (initialization.protocolVersion !== acp.PROTOCOL_VERSION) {
      throw new Error(`${launch.command} uses unsupported ACP protocol version ${initialization.protocolVersion}`)
    }
    await options.afterInitialize?.(initialization, connection.agent)
    const present = <T extends acp.NewSessionResponse | acp.LoadSessionResponse | acp.SetSessionConfigOptionResponse>(
      sessionId: string, response: T,
    ): T => {
      reasoning.remember(response)
      return reasoning.project(sessionModes.response(sessionId, response))
    }
    return {
      initialization,
      async newSession(params) {
        const created = await connection.agent.request(acp.methods.agent.session.new, params)
        rememberSession(created.sessionId)
        return present(created.sessionId, created)
      },
      async setConfigOption(params, knownOptions) {
        const current = reasoning.listed(knownOptions) ?? []
        const kind = reasoning.kind(params.configId, current)
        if (kind === "effort" || kind === "model") {
          if (typeof params.value !== "string") throw new Error(`The Agent does not offer this ${kind === "effort" ? "reasoning effort" : "model"}`)
          const option = current.find(option => option.id === params.configId)
          if (!choiceValues(option).includes(params.value)) {
            throw new Error(`The Agent does not offer this ${kind === "effort" ? "reasoning effort" : "model"}`)
          }
          if (kind === "effort") {
            await connection.agent.request(acp.methods.agent.session.setMode, { sessionId: params.sessionId, modeId: params.value })
            reasoning.noteEffort(params.value)
            return present(params.sessionId, { configOptions: current })
          }
          const switched = await connection.agent.request<unknown>("session/set_model", { sessionId: params.sessionId, modelId: params.value })
          reasoning.remember(switched)
          const advertised = typeof switched === "object" && switched !== null && "configOptions" in switched
            ? switched.configOptions as acp.SessionConfigOption[] | null | undefined : undefined
          return present(params.sessionId, {
            ...(typeof switched === "object" && switched !== null ? switched : {}),
            configOptions: advertised ?? withModelValue(current, params.value),
          })
        }
        const updated = await sessionModes.setConfigOption(
          params,
          request => connection.agent.request(acp.methods.agent.session.setMode, request),
          request => connection.agent.request(acp.methods.agent.session.setConfigOption, request),
          knownOptions,
        )
        reasoning.remember(updated)
        return reasoning.project(updated)
      },
      async resume(params) {
        rememberSession(params.sessionId)
        const capabilities = initialization.agentCapabilities
        if (capabilities?.sessionCapabilities?.resume) {
          return present(params.sessionId, await connection.agent.request(acp.methods.agent.session.resume, params))
        }
        if (!capabilities?.loadSession) throw new Error("The agent does not support session resume")
        replayingHistory = true
        try {
          const loaded = await connection.agent.request(acp.methods.agent.session.load, {
            sessionId: params.sessionId,
            cwd: params.cwd,
            mcpServers: params.mcpServers ?? [],
            ...(params.additionalDirectories?.length ? { additionalDirectories: params.additionalDirectories } : {}),
          })
          return present(params.sessionId, loaded)
        } finally {
          replayingHistory = false
        }
      },
      async prompt(params) {
        rememberSession(params.sessionId)
        return connection.agent.request(acp.methods.agent.session.prompt, params)
      },
      async steer(params, deliveryId) {
        rememberSession(params.sessionId)
        if (!supportsSteering(initialization)) throw new Error("The agent does not support steering without a new turn")
        const result = await connection.agent.request("_session/steering", {
          ...params,
          _meta: { ...params._meta, steering: { idleBehavior: "promptRequired" }, deskfleet: { deliveryId } },
        })
        const outcome = typeof result === "object" && result !== null && "outcome" in result ? result.outcome : undefined
        if (outcome === "injected") return { outcome: "injected" }
        if (outcome === "promptRequired") return { outcome: "inactive" }
        // A failed/unknown delivery is not evidence that the input was unconsumed.
        throw new Error(`Steering delivery was not confirmed (${String(outcome)})`)
      },
      cancel: sessionId => connection.agent.notify(acp.methods.agent.session.cancel, { sessionId }),
      close,
    }
  } catch (error) {
    await close()
    throw error
  } finally {
    clearTimeout(timeout)
  }
}
