import { useEventListener } from "@vueuse/core"
import { nextTick, onScopeDispose, ref } from "vue"

// The row at the top may be an empty spacer when a scrollbar drag or outline jump lands.
function readingAnchor(list: Element, top: number) {
  const rows = list.children
  let low = 0
  let high = rows.length
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (rows[mid]!.getBoundingClientRect().bottom <= top) low = mid + 1
    else high = mid
  }
  return rows[low]
}

/** One observer per transcript, including when rows are appended during streaming. */
export function useConversationViewport() {
  const printing = ref(false)
  const callbacks = new Map<Element, (nearby: boolean) => void>()
  let observer: IntersectionObserver | undefined
  useEventListener("beforeprint", () => { printing.value = true })
  useEventListener("afterprint", () => { printing.value = false })
  onScopeDispose(() => observer?.disconnect())

  function observe(row: HTMLElement, update: (nearby: boolean) => void) {
    if (!observer) {
      const root = row.closest<HTMLElement>("[data-session-scroll-viewport]")
      observer = new IntersectionObserver(entries => {
        const list = entries[0]?.target.closest("ol")
        const atBottom = root && root.scrollTop + root.clientHeight >= root.scrollHeight - 1
        const anchor = root && list && !atBottom ? readingAnchor(list, root.getBoundingClientRect().top) : undefined
        const before = anchor?.getBoundingClientRect().top
        for (const entry of entries) callbacks.get(entry.target)?.(entry.isIntersecting)
        // Several previously unseen rows above the reader can grow together. Account for
        // any native scroll anchoring already applied by comparing viewport coordinates.
        if (root) void nextTick(() => {
          if (atBottom) root.scrollTop = root.scrollHeight
          else if (anchor?.isConnected && before !== undefined) root.scrollTop += anchor.getBoundingClientRect().top - before
        })
      }, { root, rootMargin: "800px 0px" })
    }
    callbacks.set(row, update)
    observer.observe(row)
    return () => {
      observer?.unobserve(row)
      callbacks.delete(row)
    }
  }
  return { printing, observe }
}
