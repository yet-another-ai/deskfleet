/** Desktop-only loopback TCP forwarding, managed from Remote control. */
export const PORTS_IPC_CHANNEL = "deskfleet:ports"

export type PortForwardHost = "localhost" | "127.0.0.1" | "::1"
export interface PortForwardTarget { teamId: string; machineId: string }
export interface PortForwardRequest {
  target: PortForwardTarget
  /** Bind 127.0.0.1; zero (the default) asks the OS for an available port. */
  localPort?: number
  /** Literal loopback address on the target machine. Defaults to 127.0.0.1. */
  targetHost?: PortForwardHost
  targetPort: number
}
export interface PortForward {
  id: string
  target: PortForwardTarget
  localHost: "127.0.0.1"
  localPort: number
  targetHost: PortForwardHost
  targetPort: number
}
export interface PortsApi {
  start(request: PortForwardRequest): Promise<PortForward>
  list(): Promise<PortForward[]>
  stop(id: string): Promise<void>
}
