import type { CentralApi } from "./central.ts"
import type { IceCandidate, VideoCodec } from "./desktop-media.ts"
import { openNativeDesktopAttempt } from "./native-desktop-attempt.ts"
import type { NativeDesktopRequest } from "./native-desktop.ts"
import { PEER_SETUP_TIMEOUT_MS } from "./peer-lifecycle.ts"

export interface ViewerUiState {
  status: "connecting" | "starting" | "connected" | "disconnected" | "error"
  title: string
  codec?: VideoCodec
  displays: { id: number; name?: string; displayNumber?: number; width: number; height: number }[]
  displayId: number
  control: boolean
  inputReady: boolean
  secureAttention: boolean
  error?: string
  settingsError?: string
  locale?: string
  theme?: "light" | "dark"
}

export type ViewerCommand =
  | { type: "start"; title: string; codec: VideoCodec; width: number; height: number; iceServers: { urls: string[]; username?: string; credential?: string }[]; relayOnly: boolean; control: boolean }
  | { type: "answer"; sdp: string }
  | { type: "candidate"; candidate: IceCandidate }
  | { type: "ui"; state: ViewerUiState }
  | { type: "setControl"; control: boolean }
  | { type: "stop" | "close" }

export type ViewerEvent =
  | { type: "capabilities"; codecs: VideoCodec[] }
  | { type: "offer"; sdp: string }
  | { type: "candidate"; candidate: IceCandidate }
  | { type: "answerApplied" | "inputReady" | "videoReady" | "connected" | "disconnected" | "stopped" | "closeRequested" | "closed" | "reconnect" | "disconnect" }
  | { type: "selectDisplay"; displayId: number }
  | { type: "setControl"; control: boolean }
  | { type: "controlConfigured"; control: boolean; error?: string }
  | { type: "error"; error: string; reason?: "decoder" }
  | { type: "stats"; decodedFrames: number; submittedFrames: number; droppedFrames: number; width: number; height: number }

export interface ViewerProcess {
  send(command: ViewerCommand): void
  close(): Promise<void>
}
export type ViewerFactory = (event: (event: ViewerEvent) => void) => ViewerProcess

/** Authentication and signaling stay in the host; each window can replace its peer. */
export function openNativeDesktopSession(
  central: CentralApi, request: NativeDesktopRequest, spawn: ViewerFactory,
  failed: (error: Error) => void, ended: () => void,
): { opened: Promise<void>; ready: Promise<void>; close(): Promise<void> } {
  let viewer: ViewerProcess | undefined
  let current: ReturnType<typeof openNativeDesktopAttempt> | undefined
  let viewerCodecs: VideoCodec[] | undefined
  let closed = false, finished = false
  let generation = 0
  let transitions = Promise.resolve()
  let closing: Promise<void> | undefined
  let stopWaiter: { resolve(): void; reject(error: Error): void } | undefined
  const excluded = new Set<VideoCodec>()
  let selectionError: string | undefined
  let controlError: string | undefined
  let options = { ...request }
  let state: ViewerUiState = {
    status: "connecting", title: "DeskFleet", displays: [],
    displayId: request.displayId, control: request.control,
    inputReady: false, secureAttention: false,
    ...(request.locale ? { locale: request.locale } : {}),
    ...(request.theme ? { theme: request.theme } : {}),
  }
  let resolveOpened!: () => void, rejectOpened!: (error: Error) => void
  let resolveReady!: () => void, rejectReady!: (error: Error) => void
  const opened = new Promise<void>((resolve, reject) => { resolveOpened = resolve; rejectOpened = reject })
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  void opened.catch(() => {})
  void ready.catch(() => {})
  const openingTimeout = setTimeout(() => fatal(new Error("Native desktop window startup timed out")), PEER_SETUP_TIMEOUT_MS)
  const unsubscribe = central.onEvent(event => {
    if (event.type === "accountChanged") void close()
  })

  function finish(): void { if (!finished) { finished = true; ended() } }
  function update(patch: Partial<ViewerUiState>): void {
    if (closed) return
    if ("settingsError" in patch) controlError = patch.settingsError
    state = { ...state, ...patch, settingsError: selectionError ?? controlError }
    try { viewer?.send({ type: "ui", state }) }
    catch (error) { fatal(error) }
  }
  function fatal(value: unknown): void {
    if (closed) return
    const error = value instanceof Error ? value : new Error(String(value))
    rejectOpened(error); rejectReady(error)
    failed(error)
    void close().catch(error => console.error("Native desktop cleanup failed", error))
  }
  function close(): Promise<void> {
    if (closing) return closing
    closed = true
    generation++
    clearTimeout(openingTimeout)
    unsubscribe()
    current?.cancel()
    const error = new Error("Native desktop window closed")
    rejectOpened(error); rejectReady(error); stopWaiter?.reject(error)
    // The window must close immediately even when signaling is unreachable.
    void current?.release().catch(error => console.error("Native desktop peer cleanup failed", error))
    closing = (viewer?.close() ?? Promise.resolve()).finally(finish)
    return closing
  }
  function stopViewer(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => settle(new Error("Native desktop peer stop timed out")), 10_000)
      const settle = (error?: Error) => {
        clearTimeout(timeout)
        stopWaiter = undefined
        if (error) reject(error)
        else resolve()
      }
      stopWaiter = { resolve: () => settle(), reject: settle }
      try { viewer!.send({ type: "stop" }) }
      catch (error) { settle(error instanceof Error ? error : new Error(String(error))) }
    })
  }
  function report(error: Error): void {
    if (closed) return
    rejectReady(error)
    failed(error)
    update({ status: "error", inputReady: false, error: error.message })
  }
  function transition(connect: boolean, failure?: Error): void {
    const version = ++generation
    current?.cancel()
    selectionError = undefined
    update({
      status: connect ? "connecting" : "disconnected",
      displayId: options.displayId, control: options.control, inputReady: false,
      error: failure?.message,
      settingsError: undefined,
      ...(connect ? { codec: undefined, secureAttention: false } : {}),
    })
    if (failure) report(failure)
    transitions = transitions.then(async () => {
      if (closed) return
      if (current) {
        // Do not overlap either receiving peers or remote input/capture grants.
        const stopped = await Promise.allSettled([stopViewer(), current.release()])
        const failures = stopped.flatMap(result => result.status === "rejected" ? [result.reason] : [])
        if (failures.length) throw new AggregateError(failures, "Cannot release the previous native desktop peer")
        current = undefined
      }
      if (closed || version !== generation) return
      if (failure) return
      if (!connect || !viewerCodecs) return
      const attempt = openNativeDesktopAttempt(central, options, viewer!, viewerCodecs, excluded,
        patch => { if (version === generation && !closed) update(patch) },
        error => {
          if (version !== generation || closed) return
          if (error.codec && ["encoder", "decoder"].includes(error.reason ?? "")) {
            excluded.add(error.codec)
            transition(true)
          } else transition(false, error)
        })
      current = attempt
      void attempt.ready.then(() => {
        if (version === generation && !closed) resolveReady()
      }).catch(() => {})
    }).catch(error => { if (!closed && version === generation) report(error instanceof Error ? error : new Error(String(error))) })
  }
  function reconnect(): void {
    excluded.clear()
    transition(true)
  }
  function receive(event: ViewerEvent): void {
    if (closed) return
    try {
      switch (event.type) {
        case "capabilities":
          if (viewerCodecs) throw new Error("Unexpected native desktop capabilities")
          viewerCodecs = event.codecs
          clearTimeout(openingTimeout)
          resolveOpened()
          reconnect()
          break
        case "stopped": stopWaiter?.resolve(); break
        case "closeRequested": case "closed": void close(); break
        case "selectDisplay":
          if (!state.displays.some(display => display.id === event.displayId)) break
          if (current && !current.canSelectDisplay(event.displayId)) {
            selectionError = "No common native desktop video codec is available for this display"
            update({})
            break
          }
          selectionError = undefined
          if (event.displayId === options.displayId) { update({}); break }
          options = { ...options, displayId: event.displayId }
          reconnect()
          break
        case "setControl":
          if (event.control === options.control) break
          options = { ...options, control: event.control }
          update({ control: event.control, inputReady: false, settingsError: undefined })
          current?.setControl(event.control)
          break
        case "reconnect": reconnect(); break
        case "disconnect": transition(false); break
        case "error":
          if (!viewerCodecs) fatal(new Error(event.error))
          else current?.receive(event)
          break
        default: current?.receive(event)
      }
    } catch (error) { fatal(error) }
  }
  // Defer spawning so a synchronous launch failure cannot invoke ended before
  // the caller has stored its session handle.
  void Promise.resolve().then(() => {
    if (closed) return
    viewer = spawn(receive)
    update({})
  }).catch(fatal)
  return { opened, ready, close }
}
