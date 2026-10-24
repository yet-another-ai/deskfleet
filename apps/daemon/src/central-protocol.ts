import type { IceServer } from "@deskfleet/native"
import type { AgentActor } from "./agent-protocol.ts"
import type { IceCandidate } from "./control-protocol.ts"

/** Wire names are owned by crates/protocol/src/control.rs (protocol version 1). */
export interface PeerAuthorization {
  peerId: string
  serverId: string
  teamId: string
  actor: AgentActor & { kind: "user"; userId: string; deviceId: string }
  targetMachine: { id: string; originId: string; localMachineId: string }
  purpose: "agent" | "terminal" | "desktop"
  actions: string[]
  issuedAt: string
  expiresAt: string
}

export interface MachineCredentials {
  serverUrl: string
  serverId: string
  machineId: string
  teamId: string
  token: string
}

export type MachineEnrollment = Omit<MachineCredentials, "serverId">
export interface CentralStatus {
  configured: boolean
  connected: boolean
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
  | { kind: "error"; error: string }

export type ServerMessage =
  | { type: "ready"; machineId: string; teamId: string }
  | { type: "request"; id: string; method: string; params: unknown; actor?: AgentActor }
  | { type: "peerRevoked"; peerId: string; reason: string }
  | { type: "reconcilePeers"; peers: PeerAuthorization[] }
  | { type: "ping" }
  | { type: "pong" }

export function centralUrl(value: string): string {
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Use the backend's origin URL")
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("The backend requires HTTPS (HTTP is allowed for loopback tests)")
  }
  return url.origin
}
