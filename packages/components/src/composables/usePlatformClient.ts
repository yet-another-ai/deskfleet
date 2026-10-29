import { getClient } from "@deskfleet/client/platform"
import type { DeskfleetDesktopApi } from "@deskfleet/client/desktop-api"
import { hasInjectionContext, inject, type InjectionKey } from "vue"

export const platformClientKey: InjectionKey<DeskfleetDesktopApi> = Symbol("deskfleet platform client")

/** Capture the owning machine's adapter before asynchronous work can outlive selection. */
export function usePlatformClient(): DeskfleetDesktopApi {
  return (hasInjectionContext() ? inject(platformClientKey, undefined) : undefined) ?? getClient()
}
