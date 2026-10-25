import type { ControlMethod, ControlMethods, ControlRequest, DesktopStart } from "./control-protocol.ts"
import { resourceId, validateCatalogParams } from "./catalog-protocol.ts"
import { validateProviderParams } from "./provider-protocol.ts"

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object")
  return value as Record<string, unknown>
}

function sessionId(value: unknown): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
    throw new Error("Invalid desktop session ID")
  }
}

function uint(value: unknown, label: string, positive = false): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < (positive ? 1 : 0) || value > 0xffff_ffff) {
    throw new Error(`Invalid ${label}`)
  }
}

function desktopOptions(params: Record<string, unknown>): void {
  uint(params.displayId, "display ID")
  if (params.control !== undefined && typeof params.control !== "boolean") throw new Error("Invalid desktop control setting")
  if (params.fps !== undefined) uint(params.fps, "frame rate", true)
  if (params.bitrateBps !== undefined) uint(params.bitrateBps, "bitrate", true)
}

/**
 * Desktop start options the backend relays from a client. The backend sends an omitted
 * option as JSON null, but the native binding treats only undefined as absent.
 */
export function validateRelayedDesktopStart(value: unknown): Omit<DesktopStart, "sessionId"> {
  const params = object(value)
  const options = { displayId: params.displayId, fps: params.fps ?? undefined, bitrateBps: params.bitrateBps ?? undefined,
    ...(params.control === undefined || params.control === null ? {} : { control: params.control }) }
  desktopOptions(options)
  return options as Omit<DesktopStart, "sessionId">
}

export function validateControlParams<M extends ControlMethod>(method: M, value: unknown): ControlMethods[M]["params"] {
  const params = object(value)
  switch (method) {
    case "providerList":
    case "providerCreate":
    case "providerUpdate":
    case "providerRemove":
    case "providerTest":
    case "providerProbe":
    case "providerInstall":
    case "providerLogin":
      validateProviderParams(method, params)
      break
    case "directoryList":
      if (params.path !== undefined && (typeof params.path !== "string" || !params.path || params.path.includes("\0") || params.path.length > 4096)) {
        throw new Error("Invalid directory path")
      }
      break
    case "catalogList":
    case "workspaceCreate":
    case "workspaceUpdate":
    case "workspaceDelete":
    case "workspaceSessionCreate":
    case "workspaceSessionDestroy":
      validateCatalogParams(method, params)
      break
    case "hello":
      if (typeof params.token !== "string") throw new Error("Missing authentication token")
      break
    case "centralEnroll":
      for (const key of ["serverUrl", "machineId", "teamId", "token"]) {
        if (typeof params[key] !== "string" || !params[key] || (params[key] as string).length > 8192) throw new Error(`Invalid enrollment ${key}`)
      }
      break
    case "centralStatus":
    case "centralPrepareEnrollment":
    case "capabilities":
    case "terminalList":
    case "shutdown":
      break
    case "terminalDial":
      sessionId(params.terminalId)
      if (params.mode === "resume") break
      if (params.mode !== "create") throw new Error("Invalid terminal dial mode")
      for (const key of ["cols", "rows"]) {
        uint(params[key], `terminal ${key}`, true)
        if ((params[key] as number) > 1000) throw new Error(`Invalid terminal ${key}`)
      }
      if (params.cwd !== undefined && (typeof params.cwd !== "string" || params.cwd.length > 4096)) throw new Error("Invalid terminal working directory")
      if (params.worktreeId !== undefined) resourceId(params.worktreeId)
      break
    case "terminalHangup":
      sessionId(params.terminalId)
      break
    case "offer":
    case "terminalOffer":
    case "agentOffer":
      sessionId(params.sessionId)
      if (typeof params.sdp !== "string" || !params.sdp || params.sdp.length > 192 * 1024) throw new Error("Invalid SDP offer")
      if (method === "terminalOffer" || method === "agentOffer") break
      if (params.codec !== "h264" && params.codec !== "h265" && params.codec !== "av1") throw new Error("Invalid video codec")
      if (typeof params.audio !== "boolean") throw new Error("Invalid audio setting")
      break
    case "candidate": {
      sessionId(params.sessionId)
      const candidate = object(params.candidate)
      if (typeof candidate.candidate !== "string" || candidate.candidate.length > 16 * 1024) throw new Error("Invalid ICE candidate")
      for (const key of ["sdpMid", "usernameFragment"]) {
        if (candidate[key] !== undefined && typeof candidate[key] !== "string") throw new Error(`Invalid ICE ${key}`)
      }
      if (candidate.sdpMlineIndex !== undefined) {
        uint(candidate.sdpMlineIndex, "ICE media index")
        if ((candidate.sdpMlineIndex as number) > 0xffff) throw new Error("Invalid ICE media index")
      }
      break
    }
    case "start":
      sessionId(params.sessionId)
      desktopOptions(params)
      break
    case "close":
      sessionId(params.sessionId)
      break
    default: {
      const operation = typeof method === "string" && /^[A-Za-z][A-Za-z0-9]{0,127}$/u.test(method) ? `: ${method}` : ""
      throw new Error(`Unknown local daemon operation${operation}`)
    }
  }
  return params as unknown as ControlMethods[M]["params"]
}

/** A usable ID lets the server report operation errors without dropping the connection. */
export function readControlRequestId(value: unknown): number {
  const request = object(value)
  if (!Number.isSafeInteger(request.id) || (request.id as number) < 0) throw new Error("Invalid request ID")
  return request.id as number
}

export function parseControlRequest(value: unknown): ControlRequest {
  const id = readControlRequestId(value)
  const request = object(value)
  const method = request.method as ControlMethod
  const params = validateControlParams(method, request.params)
  return { id, method, params } as ControlRequest
}
