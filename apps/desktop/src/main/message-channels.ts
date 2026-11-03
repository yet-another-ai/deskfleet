import { ipcMain, type WebContents } from "electron"
import type { CentralApi } from "@deskfleet/client/central"
import type { LocalChannelOpen } from "@deskfleet/client/local-channels"
import { isDesktopMediaSender } from "./desktop-media.ts"
import type { LocalChannelDelivery } from "./local-channels-controller.ts"
import { RelayConnectionError } from "@deskfleet/client/relay"

export interface WindowMessageChannels {
  open(request: LocalChannelOpen): Promise<void>
  send(id: string, data: string | Uint8Array): Promise<void>
  acknowledge(id: string, sequence: number): Promise<void>
  close(id: string): Promise<void>
  dispose(): Promise<void>
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 1024 || value.includes("\0")) throw new Error("Invalid message channel identifier")
  return value
}
function request(value: unknown): LocalChannelOpen {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid message channel request")
  const input = value as Record<string, unknown>
  if (input.purpose !== "agent" && input.purpose !== "terminal") throw new Error("Unsupported message channel purpose")
  return { connectionId: identifier(input.connectionId), teamId: identifier(input.teamId), machineId: identifier(input.machineId), purpose: input.purpose }
}

/** Only messages cross this bridge; callers cannot create native peers or supply grants. */
export async function invokeMessageChannels(owner: WindowMessageChannels, method: unknown, args: unknown): Promise<void> {
  if (!Array.isArray(args)) throw new Error("Invalid message channel operation")
  switch (method) {
    case "open": return owner.open(request(args[0]))
    case "send": {
      if (typeof args[1] !== "string" && !(args[1] instanceof Uint8Array)) throw new Error("Invalid message channel data")
      return owner.send(identifier(args[0]), args[1])
    }
    case "ack": {
      if (!Number.isSafeInteger(args[1]) || args[1] < 1) throw new Error("Invalid message channel acknowledgement")
      return owner.acknowledge(identifier(args[0]), args[1])
    }
    case "close": return owner.close(identifier(args[0]))
    default: throw new Error("Unknown message channel operation")
  }
}

/** A navigation or crashed renderer retires its authority before a replacement document opens. */
export function installMessageChannels(
  central: Pick<CentralApi, "onEvent">,
  channel: string,
  eventChannel: string,
  create: (emit: (event: LocalChannelDelivery) => void) => WindowMessageChannels,
): { close(): Promise<void> } {
  const owners = new Map<WebContents, WindowMessageChannels>()
  const watched = new Map<WebContents, () => void>()
  const closing = new Set<Promise<void>>()
  let closed = false
  const retire = (contents: WebContents) => {
    const owner = owners.get(contents)
    if (!owner) return
    owners.delete(contents)
    const pending = owner.dispose().finally(() => closing.delete(pending))
    closing.add(pending)
  }
  const owner = (contents: WebContents) => {
    if (closed || contents.isDestroyed()) throw new Error("Message channel window has closed")
    const current = owners.get(contents)
    if (current) return current
    const next = create(event => { if (!contents.isDestroyed()) contents.send(eventChannel, event) })
    owners.set(contents, next)
    if (!watched.has(contents)) {
      const navigate = (_event: unknown, _url: string, inPlace: boolean, isMainFrame: boolean) => {
        if (isMainFrame && !inPlace) retire(contents)
      }
      const gone = () => retire(contents)
      const destroyed = () => { retire(contents); watched.get(contents)?.(); watched.delete(contents) }
      contents.on("did-start-navigation", navigate)
      contents.on("render-process-gone", gone)
      contents.once("destroyed", destroyed)
      watched.set(contents, () => {
        contents.removeListener("did-start-navigation", navigate)
        contents.removeListener("render-process-gone", gone)
        contents.removeListener("destroyed", destroyed)
      })
    }
    return next
  }
  const unsubscribe = central.onEvent(event => {
    if (event.type === "accountChanged") for (const contents of owners.keys()) retire(contents)
  })
  ipcMain.handle(channel, async (event, method: unknown, args: unknown) => {
    if (!isDesktopMediaSender(event)) throw new Error("Message channel IPC is restricted to the main renderer")
    if ((method === "ack" || method === "close") && !owners.has(event.sender)) return
    try { return await invokeMessageChannels(owner(event.sender), method, args) }
    catch (error) {
      // Electron strips custom Error fields; keep actionable relay context in plain data.
      if (error instanceof RelayConnectionError) return { relayDeniedReason: error.relayDeniedReason }
      throw error
    }
  })
  return {
    async close() {
      closed = true
      unsubscribe(); ipcMain.removeHandler(channel)
      for (const contents of owners.keys()) retire(contents)
      for (const unwatch of watched.values()) unwatch()
      watched.clear()
      await Promise.all(closing)
    },
  }
}
