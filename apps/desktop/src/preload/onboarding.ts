import { ipcRenderer } from "electron"
import { ONBOARDING_CHANNEL, type OnboardingApi } from "../../../../packages/client/src/onboarding.ts"

export function onboardingApi(): OnboardingApi {
  return {
    get: () => ipcRenderer.invoke(ONBOARDING_CHANNEL, "get"),
    saveServer: serverUrl => ipcRenderer.invoke(ONBOARDING_CHANNEL, "saveServer", serverUrl),
    permissions: () => ipcRenderer.invoke(ONBOARDING_CHANNEL, "permissions"),
    requestPermission: permission => ipcRenderer.invoke(ONBOARDING_CHANNEL, "requestPermission", permission),
    advancePermission: permission => ipcRenderer.invoke(ONBOARDING_CHANNEL, "advancePermission", permission),
    complete: () => ipcRenderer.invoke(ONBOARDING_CHANNEL, "complete"),
  }
}
