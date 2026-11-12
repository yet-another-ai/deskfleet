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
import type { OutlineAudioApi, OutlineAudioStatus } from "@deskfleet/client/outline-audio"
import { createCapacitorSpeechApi as speechApi, type SpeechBridgePlugin } from "./speech.ts"

export interface DeskFleetBridgeCapacitorPlugin extends SpeechBridgePlugin {
  authenticate(options: { url: string; callbackScheme: string }): Promise<{ url: string }>
  openExternal(options: { url: string }): Promise<void>
  open(): Promise<void>
  send(options: { command: string }): Promise<void>
  close(): Promise<void>
  testNat(options: { server: string }): Promise<NatTestResult>
  startOutlineAudio(): Promise<{ started: boolean }>
  stopOutlineAudio(): Promise<void>
  outlineAudioStatus(): Promise<OutlineAudioStatus>
  addListener(
    eventName: "speechEvent",
    listenerFunc: Parameters<SpeechBridgePlugin["addListener"]>[1],
  ): Promise<PluginListenerHandle>
  addListener(
    eventName: "viewerEvent",
    listenerFunc: (data: { payload: string }) => void,
  ): Promise<PluginListenerHandle>
  addListener(
    eventName: "outlineAudioBands",
    listenerFunc: (data: { sampleRate: number; bins: string }) => void,
  ): Promise<PluginListenerHandle>
  addListener(
    eventName: "outlineAudioStopped",
    listenerFunc: () => void,
  ): Promise<PluginListenerHandle>
}

export type ViewerBridgePlugin = Pick<
  DeskFleetBridgeCapacitorPlugin,
  "open" | "send" | "close" | "addListener"
>

export type OutlineAudioBridgePlugin = Pick<
  DeskFleetBridgeCapacitorPlugin,
  "startOutlineAudio" | "stopOutlineAudio" | "outlineAudioStatus" | "addListener"
>

export const DeskFleetBridge = registerPlugin<DeskFleetBridgeCapacitorPlugin>("DeskFleetBridge")

export function createCapacitorSpeechApi(plugin: SpeechBridgePlugin = DeskFleetBridge) {
  return speechApi(plugin)
}

const toErrorEvent = (error: unknown): ViewerEvent => ({
  type: "error",
  error: error instanceof Error ? error.message : String(error),
})

export function spawnCapacitorDesktopViewer(
  onEvent: (event: ViewerEvent) => void,
  plugin: ViewerBridgePlugin = DeskFleetBridge,
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
  openPromise.catch(emitError)

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
  plugin: ViewerBridgePlugin = DeskFleetBridge,
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

/** Drops events that arrive between unsubscribing and the asynchronous native listener removal. */
function nativeSubscription(add: (subscribed: () => boolean) => Promise<PluginListenerHandle>): () => void {
  let subscribed = true
  const handle = add(() => subscribed)
  return () => {
    subscribed = false
    void handle.then(item => item.remove())
  }
}

export function createCapacitorOutlineAudioApi(
  plugin: OutlineAudioBridgePlugin = DeskFleetBridge,
): OutlineAudioApi {
  return {
    status: () => plugin.outlineAudioStatus(),
    start: async () => (await plugin.startOutlineAudio()).started,
    stop: () => plugin.stopOutlineAudio(),
    onSpectrum: listener => nativeSubscription(subscribed => plugin.addListener("outlineAudioBands", ({ sampleRate, bins }) => {
      if (subscribed()) listener({ sampleRate, bins: Uint8Array.from(atob(bins), ch => ch.charCodeAt(0)) })
    })),
    onStopped: listener => nativeSubscription(subscribed => plugin.addListener("outlineAudioStopped", () => {
      if (subscribed()) listener()
    })),
  }
}
