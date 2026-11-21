import { useDocumentVisibility, useEventListener, watchImmediate } from "@vueuse/core"
import { onScopeDispose, ref, watch, type Ref } from "vue"
import { useDesktopTouch, type DesktopPointerMode } from "./useDesktopTouch.ts"
import { MAX_DESKTOP_CLIPBOARD_BYTES, type DesktopInputMessage, type DesktopPointerButton } from "../../../client/src/desktop-input.ts"

interface Point { x: number; y: number }
const buttonMasks: readonly (readonly [DesktopPointerButton, number])[] = [[0, 1], [1, 4], [2, 2], [3, 8], [4, 16]]

/** Match object-fit: contain, including letterboxing and capture scaling. */
export function desktopPoint(
  video: Pick<HTMLVideoElement, "videoWidth" | "videoHeight" | "getBoundingClientRect">,
  clientX: number,
  clientY: number,
  clamp = false,
): Point | null {
  const bounds = video.getBoundingClientRect()
  if (video.videoWidth <= 0 || video.videoHeight <= 0 || bounds.width <= 0 || bounds.height <= 0) return null
  const scale = Math.min(bounds.width / video.videoWidth, bounds.height / video.videoHeight)
  const width = video.videoWidth * scale
  const height = video.videoHeight * scale
  const x = (clientX - bounds.left - (bounds.width - width) / 2) / width
  const y = (clientY - bounds.top - (bounds.height - height) / 2) / height
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  if (!clamp && (x < 0 || x > 1 || y < 0 || y > 1)) return null
  return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) }
}

function pointerButton(button: number): DesktopPointerButton | null {
  return button === 0 || button === 1 || button === 2 || button === 3 || button === 4 ? button : null
}

/** Bind input only to the focused video surface; toolbar and other app controls stay local. */
export function useDesktopInput(
  video: Ref<HTMLVideoElement | null>,
  enabled: Readonly<Ref<boolean>>,
  send: (message: DesktopInputMessage) => boolean,
  reverseScroll?: Readonly<Ref<boolean>>,
  clipboardSharing?: Readonly<Ref<boolean>>,
  remoteClipboard?: Readonly<Ref<{ id: number; text: string } | null>>,
  pointerMode: Readonly<Ref<DesktopPointerMode>> = ref("absolute"),
) {
  const buttons = new Set<DesktopPointerButton>()
  const keys = new Set<string>()
  const pointers = new Set<number>()
  const macClient = navigator.platform.startsWith("Mac")
  let lastPoint: Point = { x: 0.5, y: 0.5 }
  let lastObservedLocal: string | null = null
  let lastRemoteSynced: string | null = null
  let baselineSeeded = false
  let clipboardSeq = 0
  let pasteBarrierQueue: (() => void)[] | null = null
  let pasteBarrierGeneration = 0
  let pasteBarrierTimer: ReturnType<typeof setTimeout> | null = null
  const textEncoder = new TextEncoder()

  function clipboardAllowed(): boolean {
    return enabled.value && (clipboardSharing?.value ?? true)
  }

  function sanitizeClipboard(raw: string): string | null {
    const text = raw.replaceAll("\0", "")
    if (!text || textEncoder.encode(text).byteLength > MAX_DESKTOP_CLIPBOARD_BYTES) return null
    return text
  }

  function sendClipboardText(raw: string): void {
    if (!clipboardAllowed()) return
    const text = sanitizeClipboard(raw)
    if (!text) return
    lastObservedLocal = text
    baselineSeeded = true
    if (text === lastRemoteSynced) return
    if (send({ type: "clipboard", text })) {
      lastRemoteSynced = text
    }
  }

  async function seedLocalClipboardBaseline(): Promise<void> {
    if (baselineSeeded || !clipboardAllowed() || typeof navigator.clipboard?.readText !== "function") return
    const seq = ++clipboardSeq
    try {
      const text = sanitizeClipboard(await navigator.clipboard.readText())
      if (seq !== clipboardSeq) return
      baselineSeeded = true
      if (text && lastObservedLocal === null) {
        lastObservedLocal = text
      }
    } catch {
      // Browser denied unprompted or unfocused clipboard read; retry baseline seed on focus.
    }
  }

  async function syncLocalClipboardOnFocus(): Promise<void> {
    if (!clipboardAllowed() || typeof navigator.clipboard?.readText !== "function") return
    const seq = ++clipboardSeq
    try {
      const text = sanitizeClipboard(await navigator.clipboard.readText())
      if (seq !== clipboardSeq) return
      if (!baselineSeeded) {
        baselineSeeded = true
        if (text && lastObservedLocal === null) {
          lastObservedLocal = text
        }
        return
      }
      if (!text || text === lastObservedLocal) return
      sendClipboardText(text)
    } catch {
      // Browsers may reject background or unpermitted clipboard reads.
    }
  }

  async function syncLocalClipboardForPaste(generation: number): Promise<void> {
    if (!clipboardAllowed() || typeof navigator.clipboard?.readText !== "function") return
    const seq = ++clipboardSeq
    try {
      const text = await navigator.clipboard.readText()
      if (generation !== pasteBarrierGeneration || pasteBarrierQueue === null || seq !== clipboardSeq) return
      sendClipboardText(text)
    } catch {
      // Browsers may reject unpermitted clipboard reads.
    }
  }

  function handlePaste(event: ClipboardEvent): void {
    if (!clipboardAllowed()) return
    const text = event.clipboardData?.getData("text/plain")
    if (text) {
      clipboardSeq += 1
      sendClipboardText(text)
    }
  }

  function clearPasteBarrier(): void {
    pasteBarrierGeneration += 1
    clipboardSeq += 1
    pasteBarrierQueue = null
    if (pasteBarrierTimer !== null) {
      clearTimeout(pasteBarrierTimer)
      pasteBarrierTimer = null
    }
  }

  function flushPasteBarrier(generation: number): void {
    if (generation !== pasteBarrierGeneration || pasteBarrierQueue === null) return
    pasteBarrierGeneration += 1
    clipboardSeq += 1
    const queue = pasteBarrierQueue
    pasteBarrierQueue = null
    if (pasteBarrierTimer !== null) {
      clearTimeout(pasteBarrierTimer)
      pasteBarrierTimer = null
    }
    const flushedGeneration = pasteBarrierGeneration
    for (const action of queue) {
      if (!enabled.value || flushedGeneration !== pasteBarrierGeneration) break
      action()
    }
  }

  function isPasteShortcut(event: KeyboardEvent): boolean {
    if (event.repeat) return false
    if (event.code === "KeyV") {
      return event.ctrlKey || event.metaKey
        || keys.has("ControlLeft") || keys.has("ControlRight")
        || keys.has("MetaLeft") || keys.has("MetaRight")
    }
    if (event.code === "Insert") {
      return event.shiftKey || keys.has("ShiftLeft") || keys.has("ShiftRight")
    }
    return false
  }

  function release(): void {
    touch.release()
    clearPasteBarrier()
    if (buttons.size || keys.size) send({ type: "releaseAll" })
    buttons.clear()
    keys.clear()
    const releasingPointers = [...pointers]
    pointers.clear()
    for (const pointerId of releasingPointers) {
      if (video.value?.hasPointerCapture(pointerId)) video.value.releasePointerCapture(pointerId)
    }
  }

  function position(event: PointerEvent, clamp = buttons.size > 0): Point | null {
    return video.value ? desktopPoint(video.value, event.clientX, event.clientY, clamp) : null
  }

  function pointerMove(event: PointerEvent): void {
    if (!enabled.value || event.pointerType === "touch") return
    const point = position(event)
    if (!point) return
    lastPoint = point
    if (pointers.has(event.pointerId)) {
      // Chorded presses and releases are pointermove events; pointerdown/up only
      // describe the first button pressed and the last button released.
      let changed = false
      for (const [button, mask] of buttonMasks) {
        const pressed = (event.buttons & mask) !== 0
        if (pressed === buttons.has(button)) continue
        event.preventDefault()
        if (!send({ type: "pointerButton", button, pressed, ...point })) return
        if (pressed) buttons.add(button)
        else buttons.delete(button)
        changed = true
      }
      if (changed) {
        releasePointerIfIdle(event.pointerId)
        return
      }
    }
    send({ type: "pointerMove", ...point })
  }

  function pointerDown(event: PointerEvent): void {
    if (!enabled.value || event.pointerType === "touch") return
    const button = pointerButton(event.button)
    const point = position(event)
    if (button === null || !point) return
    event.preventDefault()
    video.value?.focus({ preventScroll: true })
    if (!send({ type: "pointerButton", button, pressed: true, ...point })) return
    lastPoint = point
    buttons.add(button)
    video.value?.setPointerCapture(event.pointerId)
    pointers.add(event.pointerId)
  }

  function pointerUp(event: PointerEvent): void {
    if (event.pointerType === "touch") return
    const button = pointerButton(event.button)
    if (button === null || !buttons.has(button)) return
    event.preventDefault()
    const point = position(event, true) ?? lastPoint
    send({ type: "pointerButton", button, pressed: false, ...point })
    buttons.delete(button)
    releasePointerIfIdle(event.pointerId)
  }

  function releasePointerIfIdle(pointerId: number): void {
    if (buttons.size === 0) {
      pointers.delete(pointerId)
      if (video.value?.hasPointerCapture(pointerId)) video.value.releasePointerCapture(pointerId)
    }
  }

  function wheel(event: WheelEvent): void {
    if (!enabled.value || !video.value) return
    const point = desktopPoint(video.value, event.clientX, event.clientY)
    if (!point) return
    event.preventDefault()
    const scale = (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? video.value.clientHeight : 1) * (reverseScroll?.value ? -1 : 1)
    const rawX = Math.max(-10_000, Math.min(10_000, event.deltaX * scale))
    const rawY = Math.max(-10_000, Math.min(10_000, event.deltaY * scale))
    const deltaX = rawX === 0 ? 0 : rawX
    const deltaY = rawY === 0 ? 0 : rawY
    if (Number.isFinite(deltaX) && Number.isFinite(deltaY) && send({ type: "pointerMove", ...point })) {
      lastPoint = point
      send({ type: "wheel", deltaX, deltaY })
    }
  }

  function deliverKeyDown(code: string, repeat: boolean): void {
    if (!enabled.value) return
    if (send({ type: "key", code, pressed: true, repeat })) keys.add(code)
  }

  function deliverKeyUp(code: string): void {
    if (!keys.has(code)) return
    send({ type: "key", code, pressed: false, repeat: false })
    keys.delete(code)
    if (macClient && (code === "MetaLeft" || code === "MetaRight")) {
      // macOS browsers can omit key-up events for keys used while Command is held.
      for (const held of [...keys]) {
        if (/^(Shift|Control|Alt|Meta)(Left|Right)$/.test(held)) continue
        send({ type: "key", code: held, pressed: false, repeat: false })
        keys.delete(held)
      }
    }
  }

  function keyDown(event: KeyboardEvent): void {
    if (!enabled.value || event.isComposing || !event.code || event.code === "Unidentified") return
    event.preventDefault()
    event.stopPropagation()
    const { code, repeat } = event
    if (pasteBarrierQueue !== null) {
      pasteBarrierQueue.push(() => deliverKeyDown(code, repeat))
      return
    }
    if (
      isPasteShortcut(event)
      && clipboardAllowed()
      && typeof navigator.clipboard?.readText === "function"
    ) {
      const generation = ++pasteBarrierGeneration
      pasteBarrierQueue = [() => deliverKeyDown(code, false)]
      pasteBarrierTimer = setTimeout(() => flushPasteBarrier(generation), 150)
      void syncLocalClipboardForPaste(generation).finally(() => flushPasteBarrier(generation))
      return
    }
    deliverKeyDown(code, repeat)
  }

  function keyUp(event: KeyboardEvent): void {
    const { code } = event
    if (pasteBarrierQueue !== null) {
      event.preventDefault()
      event.stopPropagation()
      pasteBarrierQueue.push(() => deliverKeyUp(code))
      return
    }
    if (!keys.has(code)) return
    event.preventDefault()
    event.stopPropagation()
    deliverKeyUp(code)
  }

  function contextMenu(event: MouseEvent): void {
    if (enabled.value) event.preventDefault()
  }

  function lostPointerCapture(event: PointerEvent): void {
    if (pointers.has(event.pointerId)) release()
  }

  const touch = useDesktopTouch(video, enabled, pointerMode, send, () => lastPoint, point => { lastPoint = point }, reverseScroll)

  // Replacing the surface drops keys and buttons before the listeners move with it.
  watchImmediate(video, (_element, _previous, onCleanup) => { onCleanup(release) }, { flush: "post" })
  useEventListener(video, "pointermove", pointerMove)
  useEventListener(video, "pointerdown", pointerDown)
  useEventListener(video, "pointerup", pointerUp)
  useEventListener(video, "pointercancel", release)
  useEventListener(video, "lostpointercapture", lostPointerCapture)
  useEventListener(video, "wheel", wheel, { passive: false })
  useEventListener(video, "keydown", keyDown)
  useEventListener(video, "keyup", keyUp)
  useEventListener(video, "contextmenu", contextMenu)
  useEventListener(video, "paste", handlePaste)
  useEventListener(video, "blur", release)
  watchImmediate(enabled, value => {
    if (!value) release()
    else void seedLocalClipboardBaseline()
  }, { flush: "sync" })
  if (clipboardSharing) {
    watch(clipboardSharing, value => { if (value) void seedLocalClipboardBaseline() })
  }
  if (remoteClipboard) {
    watch(remoteClipboard, entry => {
      if (!entry || !clipboardAllowed()) return
      const text = sanitizeClipboard(entry.text)
      if (!text || text === lastRemoteSynced) return
      clipboardSeq += 1
      lastObservedLocal = text
      lastRemoteSynced = text
      baselineSeeded = true
      void navigator.clipboard?.writeText?.(text)?.catch(() => {})
    })
  }
  useEventListener(window, "focus", () => { void syncLocalClipboardOnFocus() })
  useEventListener(window, "blur", release)
  watch(useDocumentVisibility(), state => { if (state === "hidden") release() })
  onScopeDispose(release)
  return { release }
}
