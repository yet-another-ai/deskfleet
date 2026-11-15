import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { DESKTOP_ONBOARDING_PERMISSIONS, ONBOARDING_PERMISSIONS, onboardingPermissions, type LocalNetworkAccessRequest, type OnboardingPermission, type OnboardingPermissionsState, type OnboardingState, type OnboardingStep } from "../../../../packages/client/src/onboarding.ts"
import type { WindowsDesktopServiceState } from "../../../../packages/client/src/windows-desktop-service.ts"
import type { LocalAgentController } from "./local-agent-controller.ts"
import type { WindowsDesktopServiceController } from "./windows-desktop-service-controller.ts"

interface OnboardingOptions {
  path: string
  platform: NodeJS.Platform
  localAgent: Pick<LocalAgentController, "state" | "setEnabled" | "refreshPermissions" | "requestPermission">
  windowsDesktopService?: Pick<WindowsDesktopServiceController, "get" | "setEnabled">
  localNetwork: {
    request(): Promise<LocalNetworkAccessRequest>
    openSettings(): Promise<void>
  }
  /** True when this user-data directory already belongs to an install that predates welcome progress. */
  established?: () => boolean | Promise<boolean>
}

const establishedProfileFiles = ["account.json", "settings.json"] as const

/** An account or saved desktop settings means this profile is not a fresh install. */
export async function establishedDesktopProfile(directory: string): Promise<boolean> {
  for (const name of establishedProfileFiles) {
    try {
      await access(join(directory, name))
      return true
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
    }
  }
  return false
}

const steps: readonly OnboardingStep[] = ["account", "machineControl", ...ONBOARDING_PERMISSIONS, "complete"]
const onboardingFlow = "machine-control"
interface OnboardingProgress {
  flow: typeof onboardingFlow
  step: OnboardingStep
  /** Legacy setup already passed the permissions before this step. */
  resumePermission?: OnboardingPermission | "complete"
}

/** The host requests network access and service installation; the daemon owns native permissions. */
export class OnboardingController {
  readonly #options: OnboardingOptions
  #state: OnboardingProgress | undefined
  #localNetwork: OnboardingPermissionsState["localNetwork"] = "not-requested"
  #operation: Promise<unknown> | undefined

  constructor(options: OnboardingOptions) { this.#options = options }

  async get(): Promise<OnboardingState> {
    if (!this.#state) {
      try {
        const stored: unknown = JSON.parse(await readFile(this.#options.path, "utf8"))
        if (stored && typeof stored === "object" && "step" in stored && stored.step === "server") {
          return this.#save("account")
        }
        if (!stored || typeof stored !== "object" || !("step" in stored) || !steps.includes(stored.step as OnboardingStep)) {
          throw new Error("Invalid welcome setup progress")
        }
        const step = stored.step as OnboardingStep
        if (!("flow" in stored)) {
          // The previous flow put account after permissions. Unfinished profiles
          // must choose machine control before startup without replaying passed steps.
          if (step === "account") {
            const local = this.#options.localAgent.state
            // Client-only setup passed no daemon permissions. If control is now
            // enabled, resume with those permissions without replaying Local Network.
            const resume = local.enabled || local.status === "running" ? "complete"
              : onboardingPermissions(this.#options.platform, local.linuxDesktopBackend ?? "wayland", true)
                .find(permission => permission !== "localNetwork") ?? "complete"
            return this.#save("account", resume)
          }
          if (ONBOARDING_PERMISSIONS.includes(step as OnboardingPermission)) return this.#save("account", step as OnboardingPermission)
          this.#state = { flow: onboardingFlow, step }
        } else {
          const resumePermission = "resumePermission" in stored ? stored.resumePermission : undefined
          if (stored.flow !== onboardingFlow || resumePermission !== undefined
            && (step !== "account" && step !== "machineControl"
              || resumePermission !== "complete" && !ONBOARDING_PERMISSIONS.includes(resumePermission as OnboardingPermission))) {
            throw new Error("Invalid welcome setup progress")
          }
          this.#state = { flow: onboardingFlow, step, ...(resumePermission !== undefined ? { resumePermission: resumePermission as OnboardingPermission | "complete" } : {}) }
        }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
        if (await this.#options.established?.()) {
          try { return await this.#save("complete") }
          catch { this.#state = { flow: onboardingFlow, step: "complete" } }
        } else return this.#save("account")
      }
    }
    // The permission list preserves saved Wayland consent while its backend is unknown.
    if (ONBOARDING_PERMISSIONS.includes(this.#state.step as OnboardingPermission)
      && !this.#permissionSteps().includes(this.#state.step as OnboardingPermission)) return this.#save("complete")
    return this.#snapshot(this.#state)
  }

  #permissionSteps() {
    const local = this.#options.localAgent.state
    const backend = local.linuxDesktopBackend
    const localAgent = local.enabled || local.status === "running"
    // A saved Portal step may continue while reconnecting; fresh profiles need a known backend.
    if (backend === undefined && this.#state
      && ONBOARDING_PERMISSIONS.includes(this.#state.step as OnboardingPermission)) {
      return onboardingPermissions(this.#options.platform, "wayland", localAgent)
    }
    return onboardingPermissions(this.#options.platform, backend, localAgent)
  }

  #snapshot(state: Pick<OnboardingState, "step">): OnboardingState {
    const backend = this.#options.localAgent.state.linuxDesktopBackend
    return {
      step: state.step,
      permissionSteps: state.step === "account" || state.step === "machineControl" ? [] : this.#permissionSteps(),
      ...(this.#options.platform === "linux" && backend !== undefined ? { linuxDesktopBackend: backend } : {}),
    }
  }

  advanceAccount(): Promise<OnboardingState> {
    return this.#run(async () => {
      await this.#requireStep("account")
      return this.#save("machineControl")
    })
  }

  setMachineControlEnabled(enabled: boolean): Promise<OnboardingState> {
    return this.#run(async () => {
      await this.#requireStep("machineControl")
      const local = await this.#options.localAgent.setEnabled(enabled)
      if (local.status === "error") throw new Error(local.error ?? "Could not change machine control")
      const permissions = this.#permissionSteps()
      const next = this.#state?.resumePermission ?? permissions[0] ?? "complete"
      return this.#save(next !== "complete" && !permissions.includes(next) ? "complete" : next)
    })
  }

  async permissions(): Promise<OnboardingPermissionsState> {
    const { step, permissionSteps } = await this.get()
    if (step === "complete") {
      const desktop = permissionSteps.some(permission => DESKTOP_ONBOARDING_PERMISSIONS.some(kind => kind === permission))
        ? await this.#options.localAgent.refreshPermissions() : {}
      return {
        ...desktop,
        ...(permissionSteps.includes("localNetwork") ? { localNetwork: this.#localNetwork } : {}),
        ...(permissionSteps.includes("windowsDesktopService") ? { windowsDesktopService: await this.#windowsDesktopServiceState() } : {}),
      }
    }
    if (!ONBOARDING_PERMISSIONS.includes(step as OnboardingPermission)) throw new Error("Welcome setup is not on a permission step")
    if (step === "localNetwork") return { localNetwork: this.#localNetwork }
    if (step === "windowsDesktopService") return { windowsDesktopService: await this.#windowsDesktopServiceState() }
    return this.#options.localAgent.refreshPermissions()
  }

  async #windowsDesktopServiceState(): Promise<WindowsDesktopServiceState> {
    return this.#options.windowsDesktopService?.get() ?? { available: false, installed: false, running: false }
  }

  requestPermission(permission: OnboardingPermission): Promise<OnboardingPermissionsState> {
    return this.#run(async () => {
      const current = await this.get()
      if (current.step === "complete") {
        if (!current.permissionSteps.includes(permission)) throw new Error("Permission is unavailable in the current configuration")
      } else if (current.step !== permission) {
        if (current.step === "account" && !this.#permissionSteps().includes(permission)) {
          throw new Error("Welcome setup is not on a permission step")
        }
        throw new Error("Welcome setup step has changed")
      }
      if (permission === "localNetwork") {
        this.#localNetwork = await this.#options.localNetwork.request()
        return { localNetwork: this.#localNetwork }
      }
      if (permission === "windowsDesktopService") {
        const service = this.#options.windowsDesktopService
        if (!service) throw new Error("Windows desktop service is unavailable in this build")
        return { windowsDesktopService: await service.setEnabled(true) }
      }
      return this.#options.localAgent.requestPermission(permission)
    })
  }

  openLocalNetworkSettings(): Promise<void> {
    return this.#run(async () => {
      const current = await this.get()
      if (current.step !== "localNetwork" && !(current.step === "complete" && current.permissionSteps.includes("localNetwork"))) {
        throw new Error("Welcome setup step has changed")
      }
      await this.#options.localNetwork.openSettings()
    })
  }

  advancePermission(permission: OnboardingPermission): Promise<OnboardingState> {
    return this.#run(async () => {
      const current = await this.get()
      // X11 hello can finish a provisional Portal step while Skip/Continue is pending.
      if (current.step !== permission) {
        if ((current.step === "account" || current.step === "complete")
          && !this.#permissionSteps().includes(permission)) return current
        throw new Error("Welcome setup step has changed")
      }
      const permissions = this.#permissionSteps()
      const index = permissions.indexOf(permission)
      return this.#save(permissions[index + 1] ?? "complete")
    })
  }

  async #requireStep(step: OnboardingStep): Promise<void> {
    if ((await this.get()).step !== step) throw new Error("Welcome setup step has changed")
  }

  #run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#operation) return Promise.reject(new Error("Welcome setup is changing state"))
    const pending = operation().finally(() => { this.#operation = undefined })
    this.#operation = pending
    return pending
  }

  async #save(step: OnboardingStep, resumePermission = this.#state?.resumePermission): Promise<OnboardingState> {
    const state: OnboardingProgress = {
      flow: onboardingFlow, step,
      ...((step === "account" || step === "machineControl") && resumePermission !== undefined ? { resumePermission } : {}),
    }
    const path = this.#options.path
    await mkdir(dirname(path), { recursive: true })
    await writeFile(`${path}.tmp`, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 })
    await rename(`${path}.tmp`, path)
    this.#state = state
    return this.#snapshot(state)
  }
}
