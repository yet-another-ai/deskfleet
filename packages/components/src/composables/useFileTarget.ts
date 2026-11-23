import { computed, toValue, type MaybeRefOrGetter } from "vue"
import type { FileTarget } from "@deskfleet/client/files"
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
