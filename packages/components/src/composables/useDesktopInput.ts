import { useDocumentVisibility, useEventListener, watchImmediate } from "@vueuse/core"
import { onScopeDispose, watch, type Ref } from "vue"
import type { DesktopInputMessage, DesktopPointerButton } from "../../../client/src/desktop-input.ts"

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
) {
  const buttons = new Set<DesktopPointerButton>()
  const keys = new Set<string>()
  const pointers = new Set<number>()
  const macClient = navigator.platform.startsWith("Mac")
  let lastPoint: Point = { x: 0, y: 0 }

  function release(): void {
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
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? video.value.clientHeight : 1
    const deltaX = Math.max(-10_000, Math.min(10_000, event.deltaX * scale))
    const deltaY = Math.max(-10_000, Math.min(10_000, event.deltaY * scale))
    if (Number.isFinite(deltaX) && Number.isFinite(deltaY) && send({ type: "pointerMove", ...point })) {
      lastPoint = point
      send({ type: "wheel", deltaX, deltaY })
    }
  }

  function keyDown(event: KeyboardEvent): void {
    if (!enabled.value || event.isComposing || !event.code || event.code === "Unidentified") return
    event.preventDefault()
    event.stopPropagation()
    if (send({ type: "key", code: event.code, pressed: true, repeat: event.repeat })) keys.add(event.code)
  }

  function keyUp(event: KeyboardEvent): void {
    if (!keys.has(event.code)) return
    event.preventDefault()
    event.stopPropagation()
    send({ type: "key", code: event.code, pressed: false, repeat: false })
    keys.delete(event.code)
    if (macClient && (event.code === "MetaLeft" || event.code === "MetaRight")) {
      // macOS browsers can omit key-up events for keys used while Command is held.
      for (const code of keys) {
        if (/^(Shift|Control|Alt|Meta)(Left|Right)$/.test(code)) continue
        send({ type: "key", code, pressed: false, repeat: false })
        keys.delete(code)
      }
    }
  }

  function contextMenu(event: MouseEvent): void {
    if (enabled.value) event.preventDefault()
  }

  function lostPointerCapture(event: PointerEvent): void {
    if (pointers.has(event.pointerId)) release()
  }

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
  useEventListener(video, "blur", release)
  watch(enabled, value => { if (!value) release() }, { flush: "sync" })
  useEventListener(window, "blur", release)
  watch(useDocumentVisibility(), state => { if (state === "hidden") release() })
  onScopeDispose(release)
  return { release }
}
