import { ipcMain, type WebContents } from "electron"
import type { CentralApi } from "@deskfleet/client/central"
import { LOCAL_CHANNEL, LOCAL_CHANNEL_EVENT, type LocalChannelOpen } from "@deskfleet/client/local-channels"
import { isDesktopMediaSender } from "./desktop-media.ts"
import { DaemonClient } from "./daemon-client.ts"
import { WindowLocalChannels, type LocalChannelAuthority } from "./local-channels-controller.ts"

function identifier(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 1024 || value.includes("\0")) throw new Error("Invalid local channel identifier")
  return value
}
function request(value: unknown): LocalChannelOpen {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid local channel request")
  const input = value as Record<string, unknown>
  if (input.purpose !== "agent" && input.purpose !== "terminal") throw new Error("Unsupported local channel purpose")
  return { connectionId: identifier(input.connectionId), teamId: identifier(input.teamId), machineId: identifier(input.machineId), purpose: input.purpose }
}

/** Keep tokens and daemon methods behind a message-only bridge scoped to one renderer. */
export async function invokeLocalChannels(owner: WindowLocalChannels, method: unknown, args: unknown): Promise<void> {
  if (!Array.isArray(args)) throw new Error("Invalid local channel operation")
  switch (method) {
    case "open": return owner.open(request(args[0]))
    case "send": {
      if (typeof args[1] !== "string" && !(args[1] instanceof Uint8Array)) throw new Error("Invalid local channel data")
      return owner.send(identifier(args[0]), args[1])
    }
    case "ack": {
      if (!Number.isSafeInteger(args[1]) || args[1] < 1) throw new Error("Invalid local channel acknowledgement")
      return owner.acknowledge(identifier(args[0]), args[1])
    }
    case "close": return owner.close(identifier(args[0]))
    default: throw new Error("Unknown local channel operation")
  }
}

export function installLocalChannels(central: LocalChannelAuthority & Pick<CentralApi, "onEvent">): { close(): Promise<void> } {
  const owners = new Map<WebContents, WindowLocalChannels>()
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
    if (closed || contents.isDestroyed()) throw new Error("Local channel window has closed")
    const current = owners.get(contents)
    if (current) return current
    const next = new WindowLocalChannels(central, (event, disconnected) => DaemonClient.connect(event, disconnected), event => {
      if (!contents.isDestroyed()) contents.send(LOCAL_CHANNEL_EVENT, event)
    })
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
  ipcMain.handle(LOCAL_CHANNEL, async (event, method: unknown, args: unknown) => {
    if (!isDesktopMediaSender(event)) throw new Error("Local channel IPC is restricted to the main renderer")
    // Late ACK/close from a retired document cannot recreate its authority.
    if ((method === "ack" || method === "close") && !owners.has(event.sender)) return
    return invokeLocalChannels(owner(event.sender), method, args)
  })
  return {
    async close() {
      closed = true
      unsubscribe(); ipcMain.removeHandler(LOCAL_CHANNEL)
      for (const contents of owners.keys()) retire(contents)
      for (const unwatch of watched.values()) unwatch()
      watched.clear()
      await Promise.all(closing)
    },
  }
}
