import { ipcRenderer } from "electron"
import { LOCAL_CHANNEL, LOCAL_CHANNEL_EVENT, type LocalChannelEvent, type LocalChannelsApi } from "@deskfleet/client/local-channels"

export function localChannelsApi(): LocalChannelsApi {
  const listeners = new Set<(event: LocalChannelEvent) => void>()
  const handler = (_event: Electron.IpcRendererEvent, value: LocalChannelEvent & { sequence?: number }) => {
    try {
      // Delivery ACKs stay inside the bridge; applications see only DataChannel messages.
      const event: LocalChannelEvent = value.kind === "message"
        ? { connectionId: value.connectionId, kind: "message", data: value.data }
        : value
      for (const listener of listeners) listener(event)
    } finally {
      if (value.kind === "message") void ipcRenderer.invoke(LOCAL_CHANNEL, "ack", [value.connectionId, value.sequence]).catch(() => {})
    }
  }
  return {
    open: request => ipcRenderer.invoke(LOCAL_CHANNEL, "open", [request]),
    send: (connectionId, data) => ipcRenderer.invoke(LOCAL_CHANNEL, "send", [connectionId, data]),
    close: connectionId => ipcRenderer.invoke(LOCAL_CHANNEL, "close", [connectionId]),
    onEvent(listener) {
      if (!listeners.size) ipcRenderer.on(LOCAL_CHANNEL_EVENT, handler)
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (!listeners.size) ipcRenderer.removeListener(LOCAL_CHANNEL_EVENT, handler)
      }
    },
  }
}
