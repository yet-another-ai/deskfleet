import { ipcMain } from "electron"
import type { CentralApi } from "@deskfleet/client/central"
import { PORTS_IPC_CHANNEL, type PortForwardRequest, type PortsApi } from "@deskfleet/client/ports"
import { isDesktopMediaSender } from "./desktop-media.ts"
import { PortForwards } from "./ports-controller.ts"
import { openNativePortForward } from "./ports-peer.ts"

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid port forwarding request")
  return value as Record<string, unknown>
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 1024 || value.includes("\0")) throw new Error("Invalid port forwarding identifier")
  return value
}
function port(value: unknown, allowZero: boolean): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < (allowZero ? 0 : 1) || value > 65535) throw new Error("Invalid TCP port")
  return value
}
function request(value: unknown): PortForwardRequest {
  const input = object(value), target = object(input.target)
  if (input.targetHost !== undefined && input.targetHost !== "127.0.0.1" && input.targetHost !== "::1") throw new Error("Target must be a literal loopback address")
  if (input.localHost !== undefined) throw new Error("Local listener always binds 127.0.0.1")
  return {
    target: { teamId: identifier(target.teamId), machineId: identifier(target.machineId) },
    localPort: port(input.localPort === undefined ? 0 : input.localPort, true), targetHost: input.targetHost ?? "127.0.0.1",
    targetPort: port(input.targetPort, false),
  }
}

/** This programmatic bridge has no menu, route, or other UI entry point. */
export async function invokePorts(api: PortsApi, method: unknown, args: unknown): Promise<unknown> {
  if (typeof method !== "string" || !Array.isArray(args)) throw new Error("Invalid port forwarding operation")
  switch (method) {
    case "start": return api.start(request(args[0]))
    case "list": return api.list()
    case "stop": return api.stop(identifier(args[0]))
    default: throw new Error("Unknown port forwarding operation")
  }
}

export function installPorts(central: CentralApi): { close(): Promise<void> } {
  const forwards = new PortForwards(central, (options, failed, signal) => openNativePortForward(central, options, failed, signal))
  ipcMain.handle(PORTS_IPC_CHANNEL, async (event, method: unknown, args: unknown) => {
    if (!isDesktopMediaSender(event)) throw new Error("Port forwarding IPC is restricted to the main renderer")
    return invokePorts(forwards, method, args)
  })
  return {
    async close() { ipcMain.removeHandler(PORTS_IPC_CHANNEL); await forwards.close() },
  }
}
