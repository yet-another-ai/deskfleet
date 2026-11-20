import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { LinuxKeyringState } from "../../../../packages/client/src/settings.ts"

export const VALID_LINUX_PASSWORD_STORES = [
  "basic",
  "gnome-libsecret",
  "kwallet",
  "kwallet5",
  "kwallet6",
  "detect",
] as const

export type LinuxPasswordStore = (typeof VALID_LINUX_PASSWORD_STORES)[number]

export interface CommandLineLike {
  hasSwitch(name: string): boolean
  getSwitchValue(name: string): string
  appendSwitch(name: string, value?: string): void
}

export interface LinuxPasswordStoreOptions {
  platform: NodeJS.Platform
  path: string
  commandLine: CommandLineLike
  env?: NodeJS.ProcessEnv
  warn?: (message: string, error?: unknown) => void
}

function isLinuxPasswordStore(value: string): value is LinuxPasswordStore {
  return (VALID_LINUX_PASSWORD_STORES as readonly string[]).includes(value)
}

function parseSavedPreference(raw: string): boolean {
  const stored: unknown = JSON.parse(raw)
  if (!stored || typeof stored !== "object" || !("useSystemKeyring" in stored)
    || typeof stored.useSystemKeyring !== "boolean") {
    throw new Error("Invalid Linux keyring settings")
  }
  return stored.useSystemKeyring
}

/**
 * Configures Electron's `--password-store` switch on Linux before `app.whenReady()`.
 *
 * Precedence:
 * 1. Explicit `--password-store` CLI flag
 * 2. `DESKFLEET_PASSWORD_STORE` environment variable
 * 3. Persisted `linux-keyring.json` preference (`useSystemKeyring: false` -> `basic`)
 */
export function configureLinuxPasswordStore(options: LinuxPasswordStoreOptions): { appliedUseSystemKeyring: boolean } {
  if (options.platform !== "linux") return { appliedUseSystemKeyring: true }
  const warn = options.warn ?? ((message, error) => console.warn(message, error))

  if (options.commandLine.hasSwitch("password-store")) {
    const value = options.commandLine.getSwitchValue("password-store").trim().toLowerCase()
    return { appliedUseSystemKeyring: value !== "basic" }
  }

  const envValue = options.env?.DESKFLEET_PASSWORD_STORE?.trim().toLowerCase()
  if (envValue) {
    if (isLinuxPasswordStore(envValue)) {
      options.commandLine.appendSwitch("password-store", envValue)
      return { appliedUseSystemKeyring: envValue !== "basic" }
    }
    warn(`Ignoring unsupported DESKFLEET_PASSWORD_STORE value: ${envValue}`)
  }

  try {
    const useSystemKeyring = parseSavedPreference(readFileSync(options.path, "utf8"))
    if (!useSystemKeyring) {
      options.commandLine.appendSwitch("password-store", "basic")
      return { appliedUseSystemKeyring: false }
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      warn("Could not read Linux keyring preference; keeping system keyring", error)
    }
  }
  return { appliedUseSystemKeyring: true }
}

/** Owns the Linux opt-out preference for system keyring unlock prompts. */
export class LinuxKeyringSettingsController {
  readonly #path: string
  readonly #appliedUseSystemKeyring: boolean
  #useSystemKeyring: boolean | undefined

  constructor(path: string, appliedUseSystemKeyring: boolean) {
    this.#path = path
    this.#appliedUseSystemKeyring = appliedUseSystemKeyring
  }

  get(): LinuxKeyringState {
    if (this.#useSystemKeyring === undefined) {
      let useSystemKeyring = true
      try {
        useSystemKeyring = parseSavedPreference(readFileSync(this.#path, "utf8"))
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
      }
      this.#useSystemKeyring = useSystemKeyring
    }
    return this.#state(this.#useSystemKeyring)
  }

  setUseSystemKeyring(useSystemKeyring: boolean): LinuxKeyringState {
    mkdirSync(dirname(this.#path), { recursive: true })
    const temporary = `${this.#path}.tmp`
    writeFileSync(temporary, JSON.stringify({ useSystemKeyring }, null, 2) + "\n", { mode: 0o600 })
    renameSync(temporary, this.#path)
    this.#useSystemKeyring = useSystemKeyring
    return this.#state(useSystemKeyring)
  }

  #state(useSystemKeyring: boolean): LinuxKeyringState {
    return {
      useSystemKeyring,
      restartRequired: useSystemKeyring !== this.#appliedUseSystemKeyring,
    }
  }
}
