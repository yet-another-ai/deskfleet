import { ipcMain } from "electron"
import { ONBOARDING_CHANNEL, ONBOARDING_PERMISSIONS, type OnboardingPermission } from "../../../../packages/client/src/onboarding.ts"
import { isDesktopMediaSender } from "./desktop-media.ts"
import type { OnboardingController } from "./onboarding-controller.ts"

function permission(value: unknown): OnboardingPermission {
  if (!ONBOARDING_PERMISSIONS.includes(value as OnboardingPermission)) throw new Error("Invalid welcome permission")
  return value as OnboardingPermission
}

export function installOnboarding(controller: OnboardingController): void {
  ipcMain.handle(ONBOARDING_CHANNEL, async (event, method: unknown, value: unknown) => {
    if (!isDesktopMediaSender(event)) throw new Error("Welcome IPC is restricted to the main renderer")
    switch (method) {
      case "get": return controller.get()
      case "saveServer":
        if (typeof value !== "string") throw new Error("Server address must be a string")
        return controller.saveServer(value)
      case "permissions": return controller.permissions()
      case "requestPermission": return controller.requestPermission(permission(value))
      case "advancePermission": return controller.advancePermission(permission(value))
      case "complete": return controller.complete()
      default: throw new Error("Unknown welcome operation")
    }
  })
}
