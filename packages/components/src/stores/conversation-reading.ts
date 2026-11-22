import { defineStore } from "pinia"
import { computed, inject, reactive, type InjectionKey } from "vue"

export interface ConversationReading {
  scroll?: { top: number; bottom: boolean }
  rowHeights: Map<string, number>
  disclosures: Record<string, boolean | null>
}
export function createConversationReading(): ConversationReading {
  return { disclosures: {}, rowHeights: new Map() }
}

export const conversationReadingKey: InjectionKey<() => ConversationReading> = Symbol("conversation reading")

/** Session reading state survives route unmounts without retaining the DOM. */
export const useConversationReadingStore = defineStore("conversation-reading", () => {
  const sessions = reactive(new Map<string, ConversationReading>())
  function session(id: string): ConversationReading {
    let value = sessions.get(id)
    if (!value) {
      sessions.set(id, createConversationReading())
      value = sessions.get(id)!
    }
    return value
  }
  return { session }
})

export function useConversationDisclosures() {
  const reading = inject(conversationReadingKey, undefined)
  const fallback = reactive<Record<string, boolean | null>>({})
  return () => reading?.().disclosures ?? fallback
}

export function useConversationDisclosure(key: () => string) {
  const disclosures = useConversationDisclosures()
  return computed({
    get: () => disclosures()[key()] ?? null,
    set: (value: boolean | null) => { disclosures()[key()] = value },
  })
}
