import type { ComputedRef, InjectionKey } from "vue"

export const windowHeaderActionsTargetKey: InjectionKey<ComputedRef<string | undefined>> = Symbol("windowHeaderActionsTarget")

export function windowHeaderActionsId(groupId: string): string {
  return `deskfleet-window-actions-${groupId.replace(/[^a-zA-Z0-9_-]/g, "_")}`
}

export function windowHeaderActionsTarget(groupId: string): string {
  return `#${windowHeaderActionsId(groupId)}`
}
