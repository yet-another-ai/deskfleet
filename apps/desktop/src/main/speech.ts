import { BrowserWindow, ipcMain, type WebContents } from "electron"
import { createSpeech, speechStatus } from "@deskfleet/native"
import { SPEECH_CHANNEL, SPEECH_EVENT, type SpeechEvent } from "@deskfleet/client/speech"
import { isDesktopMediaSender } from "./desktop-media.ts"

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 128) throw new Error(`Invalid speech ${name}`)
  return value
}

function locale(value: unknown): string {
  return Intl.getCanonicalLocales(text(value, "locale"))[0]!
}

/** This service belongs to the viewing device, independently of its selected Team or Machine. */
export function installSpeech(): { close(): Promise<void> } {
  type NativeSpeech = Awaited<ReturnType<typeof createSpeech>>
  interface Active {
    owner: WebContents
    id: string
    pending: Promise<NativeSpeech>
    cancelled: boolean
    dispose(): void
  }
  let active: Active | undefined
  let closed = false

  function send(run: Active, event: SpeechEvent): void {
    if (active === run && !run.cancelled && !run.owner.isDestroyed()) run.owner.send(SPEECH_EVENT, event)
  }
  async function cancel(run: Active): Promise<void> {
    run.cancelled = true
    run.dispose()
    try { await (await run.pending).cancel() }
    finally { if (active === run) active = undefined }
  }
  async function pump(run: Active, native: NativeSpeech): Promise<void> {
    try {
      for (;;) {
        const event = await native.nextEvent()
        if (!event) {
          send(run, { sessionId: run.id, type: "ended" })
          break
        }
        send(run, event as SpeechEvent)
        if (event.type === "ended") break
      }
    } catch {
      await native.cancel().catch(() => {})
      send(run, { sessionId: run.id, type: "error", code: "failed" })
      send(run, { sessionId: run.id, type: "ended" })
    } finally {
      run.dispose()
      if (active === run) active = undefined
    }
  }

  ipcMain.handle(SPEECH_CHANNEL, async (event, method: unknown, value: unknown) => {
    if (!isDesktopMediaSender(event)) throw new Error("Speech IPC is restricted to the main renderer")
    if (closed) throw new Error("Speech service is closed")
    if (method === "status") return speechStatus(locale(value))
    if (method === "start") {
      if (!value || typeof value !== "object" || !("sessionId" in value) || !("locale" in value)) throw new Error("Invalid speech request")
      const id = text(value.sessionId, "session ID")
      const language = locale(value.locale)
      if (active) throw new Error("Speech recognition is already active")
      const owner = event.sender
      const window = BrowserWindow.fromWebContents(owner)
      const pending = createSpeech(id, language)
      const run: Active = { owner, id, pending, cancelled: false, dispose: () => {} }
      const abandon = () => { void cancel(run).catch(() => {}) }
      const navigate = (_event: unknown, _url: string, inPlace: boolean, isMainFrame: boolean) => {
        if (isMainFrame && !inPlace) abandon()
      }
      run.dispose = () => {
        owner.removeListener("destroyed", abandon)
        owner.removeListener("render-process-gone", abandon)
        owner.removeListener("did-start-navigation", navigate)
        window?.removeListener("hide", abandon)
      }
      active = run
      owner.once("destroyed", abandon)
      owner.once("render-process-gone", abandon)
      owner.on("did-start-navigation", navigate)
      window?.once("hide", abandon)
      try {
        const native = await pending
        if (!run.cancelled) void pump(run, native)
      } catch (error) {
        run.dispose()
        if (active === run) active = undefined
        throw error
      }
      return
    }
    if (method === "stop" || method === "cancel") {
      const id = text(value, "session ID")
      const run = active
      if (!run || run.id !== id || run.owner !== event.sender) return
      if (method === "cancel") await cancel(run)
      else await (await run.pending).stop()
      return
    }
    throw new Error("Unknown speech operation")
  })
  return {
    async close() {
      closed = true
      if (active) await cancel(active)
    },
  }
}
