import { useEventListener } from "@vueuse/core"
import type { Plugin } from "vue"

/** Keep application chrome above the soft keyboard when only the visual viewport resizes. */
export const visualViewportSizing: Plugin = app => {
  const viewport = window.visualViewport
  if (!viewport) return
  const style = document.documentElement.style
  const update = () => {
    // Normalize pinch zoom so magnification does not resize the terminal grid.
    style.setProperty("--app-viewport-height", `${viewport.height * viewport.scale}px`)
    // Mobile browsers can pan to the focused textarea while opening the keyboard.
    style.setProperty("--app-viewport-top", `${viewport.scale === 1 ? viewport.offsetTop : 0}px`)
  }
  const stop = useEventListener(viewport, ["resize", "scroll"], update, { passive: true })
  update()
  app.onUnmount(() => {
    stop()
    style.removeProperty("--app-viewport-height")
    style.removeProperty("--app-viewport-top")
  })
}
