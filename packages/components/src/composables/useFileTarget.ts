import { computed, onBeforeUnmount, ref, watch, toValue, type MaybeRefOrGetter } from "vue"
import type { FileTarget } from "@deskfleet/client/files"
import { usePlatformClient } from "./usePlatformClient.ts"
import { useAccountSession } from "./useAccountSession.ts"

/** Machine IDs come from the account, never from a Markdown-authored URL. */
export function useFileTarget(machineId: MaybeRefOrGetter<string | undefined>) {
  const account = useAccountSession()
  return computed<FileTarget | undefined>(() => {
    if (!account) return { kind: "local" }
    const machine = account.machines.value.find(item => item.id === toValue(machineId))
    return machine ? { kind: "machine", machineId: machine.id, teamId: machine.teamId } : undefined
  })
}

/** Stop resolving transcript links immediately when the signed-in account changes. */
export function useTranscriptFileTarget(target: () => FileTarget | undefined, conversation: () => string | null) {
  const client = usePlatformClient()
  const active = ref(true)
  watch([conversation, () => JSON.stringify(target())], () => { active.value = true })
  const unsubscribe = client.central?.onEvent(event => { if (event.type === "accountChanged") active.value = false })
  onBeforeUnmount(() => unsubscribe?.())
  return computed(() => active.value ? target() : undefined)
}
