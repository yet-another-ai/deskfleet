import type { PluginListenerHandle } from "@capacitor/core"
import type { SpeechApi, SpeechEvent, SpeechRequest, SpeechStatus } from "@deskfleet/client/speech"

export interface SpeechBridgePlugin {
  speechStatus(options: { locale: string }): Promise<SpeechStatus>
  startSpeech(options: SpeechRequest): Promise<void>
  stopSpeech(options: { sessionId: string }): Promise<void>
  cancelSpeech(options: { sessionId: string }): Promise<void>
  addListener(eventName: "speechEvent", listener: (event: SpeechEvent) => void): Promise<PluginListenerHandle>
}

/** A native listener is ready before recording can produce its first event. */
export function createCapacitorSpeechApi(plugin: SpeechBridgePlugin): SpeechApi {
  const listeners = new Set<(event: SpeechEvent) => void>()
  let registration: Promise<PluginListenerHandle> | undefined
  let activeSession: string | undefined

  const subscribe = (): Promise<PluginListenerHandle> => {
    if (!registration) {
      const pending = plugin.addListener("speechEvent", event => {
        if (event.sessionId !== activeSession) return
        if (event.type === "ended") activeSession = undefined
        for (const listener of listeners) listener(event)
      })
      registration = pending
      void pending.catch(() => {
        if (registration === pending) registration = undefined
      })
    }
    return registration
  }

  return {
    status: locale => plugin.speechStatus({ locale }),
    async start(request) {
      const previous = activeSession
      activeSession = request.sessionId
      try {
        if (previous) await plugin.cancelSpeech({ sessionId: previous })
        await subscribe()
        if (activeSession !== request.sessionId) return
        await plugin.startSpeech(request)
      } catch (error) {
        if (activeSession === request.sessionId) activeSession = undefined
        throw error
      }
    },
    async stop(sessionId) {
      if (activeSession === sessionId) await plugin.stopSpeech({ sessionId })
    },
    async cancel(sessionId) {
      if (activeSession !== sessionId) return
      activeSession = undefined
      await plugin.cancelSpeech({ sessionId })
    },
    onEvent(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
