import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { ONBOARDING_PERMISSIONS, onboardingPermissions, type OnboardingPermission, type OnboardingState, type OnboardingStep } from "../../../../packages/client/src/onboarding.ts"
import type { LocalAgentController } from "./local-agent-controller.ts"

interface OnboardingOptions {
  path: string
  platform: NodeJS.Platform
  localAgent: Pick<LocalAgentController, "state" | "refreshPermissions" | "requestPermission">
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

const steps: readonly OnboardingStep[] = [...ONBOARDING_PERMISSIONS, "account", "complete"]

/** The welcome flow records progress; the daemon owns every OS permission action. */
export class OnboardingController {
  readonly #options: OnboardingOptions
  #state: OnboardingState | undefined
  #operation: Promise<unknown> | undefined

  constructor(options: OnboardingOptions) { this.#options = options }

  async get(): Promise<OnboardingState> {
    if (!this.#state) {
      try {
        const stored: unknown = JSON.parse(await readFile(this.#options.path, "utf8"))
        if (stored && typeof stored === "object" && "step" in stored && stored.step === "server") {
          return this.#save(this.#initialStep())
        }
        if (!stored || typeof stored !== "object" || !("step" in stored) || !steps.includes(stored.step as OnboardingStep)) {
          throw new Error("Invalid welcome setup progress")
        }
        this.#state = { step: stored.step as OnboardingStep }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
        if (await this.#options.established?.()) {
          try { this.#state = await this.#save("complete") }
          catch { this.#state = { step: "complete" } }
        } else return this.#save(this.#initialStep())
      }
    }
    // The permission list preserves saved Wayland consent while its backend is unknown.
    if (ONBOARDING_PERMISSIONS.includes(this.#state.step as OnboardingPermission)
      && !this.#permissionSteps().includes(this.#state.step as OnboardingPermission)) return this.#save("account")
    return this.#snapshot(this.#state)
  }

  #permissionSteps() {
    const backend = this.#options.localAgent.state.linuxDesktopBackend
    // A saved Portal step may continue while reconnecting; fresh profiles need a known backend.
    if (backend === undefined && this.#state
      && ONBOARDING_PERMISSIONS.includes(this.#state.step as OnboardingPermission)) {
      return onboardingPermissions(this.#options.platform, "wayland")
    }
    return onboardingPermissions(this.#options.platform, backend)
  }

  #snapshot(state: OnboardingState): OnboardingState {
    const backend = this.#options.localAgent.state.linuxDesktopBackend
    return this.#options.platform === "linux" && backend !== undefined ? { ...state, linuxDesktopBackend: backend } : { ...state }
  }

  #initialStep(): OnboardingStep {
    const local = this.#options.localAgent.state
    return local.enabled || local.status === "running"
      ? this.#permissionSteps()[0] ?? "account" : "account"
  }

  async permissions() {
    const { step } = await this.get()
    if (!ONBOARDING_PERMISSIONS.includes(step as OnboardingPermission)) throw new Error("Welcome setup is not on a permission step")
    return this.#options.localAgent.refreshPermissions()
  }

  requestPermission(permission: OnboardingPermission) {
    return this.#run(async () => {
      const current = await this.get()
      if (current.step !== permission) {
        if ((current.step === "account" || current.step === "complete")
          && !this.#permissionSteps().includes(permission)) {
          throw new Error("Welcome setup is not on a permission step")
        }
        throw new Error("Welcome setup step has changed")
      }
      return this.#options.localAgent.requestPermission(permission)
    })
  }

  advancePermission(permission: OnboardingPermission): Promise<OnboardingState> {
    return this.#run(async () => {
      const current = await this.get()
      // X11 hello can rewrite a provisional Portal step; Skip/Continue must reach account.
      if (current.step !== permission) {
        if ((current.step === "account" || current.step === "complete")
          && !this.#permissionSteps().includes(permission)) return current
        throw new Error("Welcome setup step has changed")
      }
      const permissions = this.#permissionSteps()
      const index = permissions.indexOf(permission)
      return this.#save(permissions[index + 1] ?? "account")
    })
  }

  complete(): Promise<OnboardingState> {
    return this.#run(async () => {
      await this.#requireStep("account")
      return this.#save("complete")
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

  async #save(step: OnboardingStep): Promise<OnboardingState> {
    const state = { step }
    const path = this.#options.path
    await mkdir(dirname(path), { recursive: true })
    await writeFile(`${path}.tmp`, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 })
    await rename(`${path}.tmp`, path)
    this.#state = state
    return this.#snapshot(state)
  }
}
