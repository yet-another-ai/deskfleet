import { useEventListener } from "@vueuse/core"
import { watch, type Ref } from "vue"
import type { DesktopInputMessage } from "@deskfleet/client/desktop-input"
import { desktopPoint } from "./useDesktopInput.ts"

export type DesktopPointerMode = "absolute" | "relative"
interface Point { x: number; y: number }
interface Contact { x: number; y: number; startX: number; startY: number }

/** Touch gestures share the existing normalized pointer protocol with physical mice. */
export function useDesktopTouch(
  video: Ref<HTMLVideoElement | null>, enabled: Readonly<Ref<boolean>>,
  mode: Readonly<Ref<DesktopPointerMode>>, send: (message: DesktopInputMessage) => boolean,
  getPoint: () => Point, setPoint: (point: Point) => void,
  reverseScroll?: Readonly<Ref<boolean>>,
) {
  const contacts = new Map<number, Contact>()
  let dragged = false, moved = false, multi = false, longPressed = false
  let lastTap: { x: number; y: number; time: number } | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const clearTimer = () => { clearTimeout(timer); timer = undefined }
  const button = (pressed: boolean, secondary = false) => send({ type: "pointerButton", button: secondary ? 2 : 0, pressed, ...getPoint() })

  function release(): void {
    clearTimer()
    if (dragged) button(false)
    dragged = false
    lastTap = undefined
    const ids = [...contacts.keys()]
    contacts.clear()
    for (const id of ids) if (video.value?.hasPointerCapture(id)) video.value.releasePointerCapture(id)
  }
  function down(event: PointerEvent): void {
    if (!enabled.value || event.pointerType !== "touch" || !video.value) return
    const point = desktopPoint(video.value, event.clientX, event.clientY)
    if (mode.value === "absolute" && !point) return
    event.preventDefault()
    if (contacts.size === 0) {
      // Focus before registering this gesture, as moving focus releases prior input.
      video.value.focus({ preventScroll: true })
      moved = multi = longPressed = false
      if (mode.value === "absolute" && point) setPoint(point)
      if (mode.value === "relative" && lastTap && event.timeStamp - lastTap.time < 350
        && Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < 30) {
        dragged = button(true)
        lastTap = undefined
      }
      timer = setTimeout(() => {
        if (!enabled.value || moved || multi || dragged) return
        longPressed = true
        if (button(true, true)) button(false, true)
      }, 500)
    } else {
      multi = true
      clearTimer()
      if (dragged) button(false)
      dragged = false
    }
    contacts.set(event.pointerId, { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY })
    video.value.setPointerCapture(event.pointerId)
  }
  function move(event: PointerEvent): void {
    const contact = contacts.get(event.pointerId)
    if (!contact || !enabled.value || !video.value) return
    event.preventDefault()
    const dx = event.clientX - contact.x, dy = event.clientY - contact.y
    contact.x = event.clientX; contact.y = event.clientY
    if (!moved && Math.hypot(contact.x - contact.startX, contact.y - contact.startY) < 6) return
    moved = true
    clearTimer()
    if (multi) {
      // Each contact contributes to the centroid, avoiding doubled scroll speed.
      if (contacts.size >= 2) {
        const direction = reverseScroll?.value ? 1 : -1
        if (send({ type: "pointerMove", ...getPoint() })) {
          send({ type: "wheel", deltaX: dx * direction / contacts.size, deltaY: dy * direction / contacts.size })
        }
      }
      return
    }
    if (longPressed) return
    let point: Point | null
    if (mode.value === "relative") {
      const rect = video.value.getBoundingClientRect()
      const scale = Math.min(rect.width / video.value.videoWidth, rect.height / video.value.videoHeight)
      if (!(scale > 0) || !Number.isFinite(scale)) return
      const previous = getPoint()
      point = { x: Math.max(0, Math.min(1, previous.x + dx / (video.value.videoWidth * scale))), y: Math.max(0, Math.min(1, previous.y + dy / (video.value.videoHeight * scale))) }
    } else {
      if (!dragged) dragged = button(true)
      point = desktopPoint(video.value, event.clientX, event.clientY, true)
    }
    if (point && send({ type: "pointerMove", ...point })) setPoint(point)
  }
  function up(event: PointerEvent): void {
    if (!contacts.has(event.pointerId)) return
    event.preventDefault()
    clearTimer()
    contacts.delete(event.pointerId)
    if (!contacts.size) {
      if (dragged) button(false)
      else if (!moved && !multi && !longPressed && enabled.value && button(true)) {
        button(false)
        lastTap = { x: event.clientX, y: event.clientY, time: event.timeStamp }
      } else lastTap = undefined
      dragged = false
    }
    if (video.value?.hasPointerCapture(event.pointerId)) video.value.releasePointerCapture(event.pointerId)
  }
  useEventListener(video, "pointerdown", down)
  useEventListener(video, "pointermove", move)
  useEventListener(video, "pointerup", up)
  useEventListener(video, "lostpointercapture", event => { if (contacts.has(event.pointerId)) release() })
  watch(mode, release, { flush: "sync" })
  return { release }
}
