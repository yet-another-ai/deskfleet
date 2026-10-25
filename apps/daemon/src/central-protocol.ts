import type { ControlMessage, IceServer, PeerAuthorization as WirePeerAuthorization } from "../../../crates/protocol/control.ts"
import type { AgentActor } from "./agent-protocol.ts"
import type { IceCandidate } from "./control-protocol.ts"

/** Wire names are owned by crates/protocol/src/control.rs (protocol version 1). */
export interface PeerAuthorization extends Omit<WirePeerAuthorization, "actor" | "purpose"> {
  actor: AgentActor & { kind: "user"; userId: string; deviceId: string }
  purpose: "agent" | "terminal" | "desktop"
}

export interface MachineCredentials {
  serverUrl: string
  serverId: string
  machineId: string
  teamId: string
  token: string
  revoked?: boolean
}

export type MachineEnrollment = Omit<MachineCredentials, "serverId" | "revoked">
export interface CentralStatus {
  configured: boolean
  connected: boolean
  revoked: boolean
  serverUrl?: string
  machineId?: string
  teamId?: string
  identity: { originId: string; machineId: string }
  machineName: string
}

export interface PeerOffer {
  peerId: string
  sdp: string
  authorization: PeerAuthorization
  iceServers: IceServer[]
  options?: { codec?: "h264" | "h265" | "av1"; audio?: boolean }
}

export type PeerSignal =
  | { kind: "iceCandidate"; candidate: IceCandidate }
  | { kind: "stateChanged"; state: string }
  | { kind: "error"; error: string; reason?: "encoder" }

export type ServerMessage = Extract<ControlMessage, { type: "ready" | "peerRevoked" | "ping" | "pong" }>
  | (Omit<Extract<ControlMessage, { type: "request" }>, "actor"> & { actor?: PeerAuthorization["actor"] })
  | (Omit<Extract<ControlMessage, { type: "reconcilePeers" }>, "peers"> & { peers: PeerAuthorization[] })

export function centralUrl(value: string): string {
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Use the backend's origin URL")
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("The backend requires HTTPS (HTTP is allowed for loopback tests)")
  }
  return url.origin
}
