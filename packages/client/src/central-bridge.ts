import type { CentralApi, CentralEvent } from "./central.ts"
import type { DesktopErrorReportingContext } from "./error-reporting-context.ts"
import { deserializeCentralRequestError, serializeCentralRequestError, type CentralRequestError, type SerializedCentralRequestError } from "./request-diagnostics.ts"

export const CENTRAL_METHODS = [
  "search", "scheduleSnapshot",
  "status", "login", "logout", "site", "teams", "createTeam", "enrollHeadless", "members", "teamUsage", "aiUsage", "aiUsageSessions", "openAccountSettings", "githubSettings", "manageGithub", "authorizeGithubApp", "setGithubActAsYou", "githubPullRequest", "billing", "checkout", "billingPortal", "renameTeam", "invite", "acceptInvite", "setMemberRole", "removeMember", "transferOwnership", "machines", "renameMachine", "removeMachine", "localEnrollment", "enrollLocal", "catalog", "sessions", "session", "events", "rpc", "createPeer", "offerPeer", "startPeer", "candidatePeer", "closePeer",
] as const satisfies readonly (keyof CentralApi)[]

export type CentralIpcResult = { ok: true; value: unknown } | {
  ok: false
  error: { message: string; request?: SerializedCentralRequestError }
}

/** Plain results cross both Electron IPC and contextBridge before errors are rebuilt. */
export interface CentralBridge {
  invoke(method: typeof CENTRAL_METHODS[number], args: unknown[]): Promise<CentralIpcResult>
  context(): Promise<DesktopErrorReportingContext>
  onEvent(listener: (event: CentralEvent) => void): () => void
}

export function centralIpcFailure(error: unknown): CentralIpcResult {
  const request = serializeCentralRequestError(error)
  return { ok: false, error: {
    // Keep the existing UI-facing message while carrying diagnostics separately.
    message: `Error invoking remote method 'deskfleet:central': ${String(error)}`,
    ...(request ? { request } : {}),
  } }
}

/** Reconstruct and report in the renderer, where the Sentry SDK owns the Error. */
export function centralBridgeClient(bridge: CentralBridge, report: (error: CentralRequestError) => void): CentralApi {
  const methods = Object.fromEntries(CENTRAL_METHODS.map(method => [method, async (...args: unknown[]) => {
    const result = await bridge.invoke(method, args)
    if (result.ok) return result.value
    const error = result.error.request ? deserializeCentralRequestError(result.error.request) : new Error(result.error.message)
    error.message = result.error.message
    if (result.error.request) {
      // Observability must not replace the original request failure.
      try { report(error as CentralRequestError) } catch { /* retain the request error */ }
    }
    throw error
  }]))
  return { ...methods, onEvent: (listener: (event: CentralEvent) => void) => bridge.onEvent(listener) } as unknown as CentralApi
}
