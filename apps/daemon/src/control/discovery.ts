import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import type { DaemonDiscovery } from "@deskfleet/protocol/control"

export function daemonControlDirectory(): string {
  return process.env.DESKFLEET_DAEMON_DIRECTORY || join(homedir(), ".deskfleet")
}

export function daemonDiscoveryPath(directory = daemonControlDirectory()): string {
  return join(directory, "daemon.json")
}

export async function readDaemonDiscovery(directory = daemonControlDirectory()): Promise<DaemonDiscovery> {
  const value: unknown = JSON.parse(await readFile(daemonDiscoveryPath(directory), "utf8"))
  if (!value || typeof value !== "object" || !("endpoint" in value) || !("token" in value)
    || typeof value.endpoint !== "string" || typeof value.token !== "string"
    || !isLocalControlEndpoint(value.endpoint) || !/^[a-f0-9]{64}$/u.test(value.token)) {
    throw new Error("Invalid local daemon discovery file")
  }
  return { endpoint: value.endpoint, token: value.token }
}

export function isLocalControlEndpoint(endpoint: string): boolean {
  return process.platform === "win32" ? endpoint.startsWith("\\\\.\\pipe\\") : isAbsolute(endpoint)
}
