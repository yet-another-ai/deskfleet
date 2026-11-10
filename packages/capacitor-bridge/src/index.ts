import { registerPlugin, type PluginListenerHandle } from "@capacitor/core"
import type { CentralApi } from "@deskfleet/client/central"
import type { HttpCentralClient } from "@deskfleet/client/http-central"
import type { NativeDesktopApi, NativeDesktopRequest } from "@deskfleet/client/native-desktop"
import {
  openNativeDesktopSession,
  type ViewerCommand,
  type ViewerEvent,
  type ViewerProcess,
} from "@deskfleet/client/native-desktop-session"
import {
  stunEndpoint,
  type NatTestResult,
  type NetworkDiagnosticsApi,
} from "@deskfleet/client/network-diagnostics"

export interface DeskFleetBridgeCapacitorPlugin {
  openExternal(options: { url: string }): Promise<void>
  open(): Promise<void>
  send(options: { command: string }): Promise<void>
  close(): Promise<void>
  testNat(options: { server: string }): Promise<NatTestResult>
  addListener(
    eventName: "viewerEvent",
    listenerFunc: (data: { payload: string }) => void,
  ): Promise<PluginListenerHandle>
}

export const DeskFleetBridge = registerPlugin<DeskFleetBridgeCapacitorPlugin>("DeskFleetBridge")

const toErrorEvent = (error: unknown): ViewerEvent => ({
  type: "error",
  error: error instanceof Error ? error.message : String(error),
})

export function spawnCapacitorDesktopViewer(
  onEvent: (event: ViewerEvent) => void,
  plugin: DeskFleetBridgeCapacitorPlugin = DeskFleetBridge,
): ViewerProcess {
  let closed = false
  let ready = false
  const pending: ViewerEvent[] = []
  const emitError = (error: unknown) => {
    if (!closed) onEvent(toErrorEvent(error))
  }

  const listenerPromise = plugin.addListener("viewerEvent", ({ payload }) => {
    if (closed) return
    try {
      const event = JSON.parse(payload) as ViewerEvent
      if (ready) onEvent(event)
      else pending.push(event)
    } catch (error) {
      emitError(error)
    }
  })

  const openPromise = listenerPromise.then(async () => {
    ready = true
    for (const queued of pending.splice(0)) {
      if (!closed) onEvent(queued)
    }
    if (!closed) await plugin.open()
  })
  void openPromise.catch(emitError)

  let sendChain = openPromise.catch(() => {})

  return {
    send(command: ViewerCommand): void {
      if (closed) return
      const payload = JSON.stringify(command)
      sendChain = sendChain
        .then(async () => {
          if (!closed) await plugin.send({ command: payload })
        })
        .catch(emitError)
    },
    async close(): Promise<void> {
      if (closed) return
      closed = true
      await listenerPromise.then(h => h.remove()).catch(() => {})
      await plugin.close().catch(() => {})
    },
  }
}

export function createCapacitorNativeDesktopApi(
  central: CentralApi,
  plugin: DeskFleetBridgeCapacitorPlugin = DeskFleetBridge,
): NativeDesktopApi {
  let active: ReturnType<typeof openNativeDesktopSession> | undefined
  return {
    async open(request: NativeDesktopRequest): Promise<void> {
      await active?.close()
      const session = openNativeDesktopSession(
        central,
        request,
        receive => spawnCapacitorDesktopViewer(receive, plugin),
        error => console.error("Capacitor native desktop session failed", error),
        () => {
          if (active === session) active = undefined
        },
      )
      active = session
      await session.ready
    },
  }
}

export function createCapacitorNetworkDiagnosticsApi(
  central: Pick<HttpCentralClient, "networkConfiguration">,
  plugin: Pick<DeskFleetBridgeCapacitorPlugin, "testNat"> = DeskFleetBridge,
  noStunServerMessage: string | (() => string | Promise<string>) = "This DeskFleet service has no IPv4 UDP STUN server configured. Contact the service administrator.",
): NetworkDiagnosticsApi {
  return {
    async testNat(): Promise<NatTestResult> {
      const configuration = await central.networkConfiguration()
      const server = stunEndpoint(configuration.stunUrls)
      if (!server) {
        const message = typeof noStunServerMessage === "function" ? await noStunServerMessage() : noStunServerMessage
        throw new Error(message)
      }
      return plugin.testNat({ server })
    },
  }
}
