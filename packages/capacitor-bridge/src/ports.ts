import type { PluginListenerHandle } from "@capacitor/core"
import type { CentralApi } from "@deskfleet/client/central"
import type { IceCandidate } from "@deskfleet/client/desktop-media"
import type { PortsApi } from "@deskfleet/client/ports"
import { PortForwards } from "@deskfleet/client/ports-controller"
import { connectPortPeer, type PortPeerFactory } from "@deskfleet/client/ports-signaling"

export interface PortsBridgePlugin {
  portsCall(options: { request: string }): Promise<{ response: string }>
  addListener(
    eventName: "portsEvent",
    listenerFunc: (data: { payload: string }) => void,
  ): Promise<PluginListenerHandle>
}

interface NativePortsResponse<T> {
  result?: T
  error?: string
}

type NativePortsEvent =
  | { peerId: string; kind: "iceCandidate"; candidate: IceCandidate }
  | { peerId: string; kind: "open" }
  | { peerId: string; kind: "error"; error?: string }

function parseResponse<T>(raw: string): T {
  const parsed = JSON.parse(raw) as NativePortsResponse<T>
  if (parsed.error) throw new Error(parsed.error)
  if (parsed.result === undefined) throw new Error("Missing native port forwarding result")
  return parsed.result
}

/** Exposes native WebRTC loopback port forwarding through Capacitor's bridge. */
export function createCapacitorPortsApi(central: CentralApi, plugin: PortsBridgePlugin): PortsApi {
  return new PortForwards(central, (request, failed, signal) => {
    const peerId = globalThis.crypto.randomUUID()
    const factory: PortPeerFactory = async (iceServers, events) => {
      let closed = false
      let created = false
      let listener: PluginListenerHandle | undefined
      let closing: Promise<void> | undefined

      const call = async <T>(payload: Record<string, unknown>): Promise<T> => {
        const { response } = await plugin.portsCall({ request: JSON.stringify(payload) })
        return parseResponse<T>(response)
      }

      const close = (): Promise<void> => {
        if (closing) return closing
        closed = true
        signal.removeEventListener("abort", onAbort)
        closing = Promise.resolve().then(async () => {
          await listener?.remove().catch(() => {})
          if (created) await call<{ ok: boolean }>({ op: "close", peerId }).catch(() => {})
        })
        return closing
      }

      const onAbort = () => { void close().catch(() => {}) }
      signal.addEventListener("abort", onAbort, { once: true })
      if (signal.aborted) {
        await close()
        throw new Error("Port forwarding was cancelled")
      }

      try {
        listener = await plugin.addListener("portsEvent", ({ payload }) => {
          if (closed) return
          let event: NativePortsEvent
          try {
            event = JSON.parse(payload) as NativePortsEvent
          } catch {
            return
          }
          if (event.peerId !== peerId) return
          if (event.kind === "iceCandidate") events.candidate(event.candidate)
          else if (event.kind === "open") events.open()
          else if (event.kind === "error") events.fail(new Error(event.error || "Port forwarding peer closed"))
        })
        if (closed || signal.aborted) {
          await close()
          throw new Error("Port forwarding was cancelled")
        }
        const { localPort } = await call<{ localPort: number }>({
          op: "create",
          peerId,
          iceServers: iceServers.map(server => ({
            urls: typeof server.urls === "string" ? [server.urls] : server.urls,
            username: server.username ?? "",
            credential: server.credential ?? "",
          })),
          localPort: request.localPort ?? 0,
          targetHost: request.targetHost ?? "127.0.0.1",
          targetPort: request.targetPort,
        })
        created = true
        if (closed || signal.aborted) {
          await close()
          throw new Error("Port forwarding was cancelled")
        }
        return {
          localPort,
          close,
          offer: async () => (await call<{ sdp: string }>({ op: "offer", peerId })).sdp,
          answer: async sdp => { await call<{ ok: boolean }>({ op: "answer", peerId, sdp }) },
          candidate: async candidate => { await call<{ ok: boolean }>({ op: "candidate", peerId, candidate }) },
        }
      } catch (error) {
        await close()
        throw error
      }
    }
    return connectPortPeer(central, request.target, factory, failed, signal)
  })
}
