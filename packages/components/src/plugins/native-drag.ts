import { useEventListener } from "@vueuse/core"
import type { Plugin } from "vue"

/** Application links and icons are controls; selectable content keeps native dragging. */
export const nativeDragPolicy: Plugin = app => {
  const stop = useEventListener(document, "dragstart", event => {
    const source = event.target instanceof Element ? event.target : null
    if (source?.closest("a, img") && !source.closest('.ui-markdown, .select-text, [draggable="true"]')) {
      event.preventDefault()
    }
  }, { capture: true })
  // Document capture also covers nested machine apps and teleported controls.
  app.onUnmount(stop)
}
