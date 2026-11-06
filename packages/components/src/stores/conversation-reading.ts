import { defineStore } from "pinia"
import { computed, inject, reactive, type InjectionKey } from "vue"

export interface ConversationReading {
  scroll?: { top: number; bottom: boolean }
  disclosures: Record<string, boolean | null>
}
export const conversationReadingKey: InjectionKey<() => ConversationReading> = Symbol("conversation reading")

/** Machine-scoped UI state survives route unmounts without retaining the DOM. */
export const useConversationReadingStore = defineStore("conversation-reading", () => {
  const sessions = reactive(new Map<string, ConversationReading>())
  function session(id: string): ConversationReading {
    let value = sessions.get(id)
    if (!value) {
      sessions.set(id, { disclosures: {} })
      value = sessions.get(id)!
    }
    return value
  }
  return { session }
})

export function useConversationDisclosure(key: () => string) {
  const reading = inject(conversationReadingKey, undefined)
  const fallback = reactive<Record<string, boolean | null>>({})
  return computed({
    get: () => (reading?.().disclosures ?? fallback)[key()] ?? null,
    set: (value: boolean | null) => { (reading?.().disclosures ?? fallback)[key()] = value },
  })
}
