import { ipcRenderer } from "electron"
import { SPEECH_CHANNEL, SPEECH_EVENT, type SpeechApi, type SpeechEvent } from "@deskfleet/client/speech"

export function speechApi(): SpeechApi {
  return {
    status: locale => ipcRenderer.invoke(SPEECH_CHANNEL, "status", locale),
    start: request => ipcRenderer.invoke(SPEECH_CHANNEL, "start", request),
    stop: sessionId => ipcRenderer.invoke(SPEECH_CHANNEL, "stop", sessionId),
    cancel: sessionId => ipcRenderer.invoke(SPEECH_CHANNEL, "cancel", sessionId),
    onEvent(listener) {
      const handler = (_event: Electron.IpcRendererEvent, event: SpeechEvent) => listener(event)
      ipcRenderer.on(SPEECH_EVENT, handler)
      return () => { ipcRenderer.removeListener(SPEECH_EVENT, handler) }
    },
  }
}
