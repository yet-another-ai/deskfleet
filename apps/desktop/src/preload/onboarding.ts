import { ipcRenderer } from "electron"
import { ONBOARDING_CHANNEL, type OnboardingApi } from "@deskfleet/client/onboarding"

export function onboardingApi(): OnboardingApi {
  return {
    get: () => ipcRenderer.invoke(ONBOARDING_CHANNEL, "get"),
    advanceAccount: () => ipcRenderer.invoke(ONBOARDING_CHANNEL, "advanceAccount"),
    setMachineControlEnabled: enabled => ipcRenderer.invoke(ONBOARDING_CHANNEL, "setMachineControlEnabled", enabled),
    permissions: () => ipcRenderer.invoke(ONBOARDING_CHANNEL, "permissions"),
    requestPermission: permission => ipcRenderer.invoke(ONBOARDING_CHANNEL, "requestPermission", permission),
    openLocalNetworkSettings: () => ipcRenderer.invoke(ONBOARDING_CHANNEL, "openLocalNetworkSettings"),
    advancePermission: permission => ipcRenderer.invoke(ONBOARDING_CHANNEL, "advancePermission", permission),
  }
}
