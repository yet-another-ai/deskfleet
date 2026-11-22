import { shallowRef } from "vue"
import { springScrollIntoView } from "./spring-scroll.ts"

export const scrollingToConversationEntry = shallowRef<{ entryId: string; sessionId?: string }>()

/** Keep an offscreen locate target mounted until its scroll finishes or is interrupted. */
export function scrollToConversationEntry(element: HTMLElement, sessionId?: string) {
  const entryId = element.closest<HTMLElement>("[data-conversation-entry]")?.dataset.conversationEntry
  const target = entryId ? { entryId, sessionId } : undefined
  scrollingToConversationEntry.value = target
  function release() {
    if (scrollingToConversationEntry.value === target) scrollingToConversationEntry.value = undefined
  }
  void springScrollIntoView(element).finished.then(completed => {
    // Reduced motion can reach the target before IntersectionObserver has delivered its first visible entry.
    if (completed && target) requestAnimationFrame(() => requestAnimationFrame(release))
    else release()
  })
}
