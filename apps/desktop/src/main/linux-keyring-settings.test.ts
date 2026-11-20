import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test, vi } from "vitest"
import {
  configureLinuxPasswordStore,
  LinuxKeyringSettingsController,
  type CommandLineLike,
} from "./linux-keyring-settings.ts"

const roots: string[] = []
function tempPath(name = "linux-keyring.json"): string {
  const dir = mkdtempSync(join(tmpdir(), "deskfleet-linux-keyring-"))
  roots.push(dir)
  return join(dir, name)
}

function fakeCommandLine(initial?: Record<string, string>): CommandLineLike & { switches: Map<string, string> } {
  const switches = new Map<string, string>(Object.entries(initial ?? {}))
  return {
    switches,
    hasSwitch: name => switches.has(name),
    getSwitchValue: name => switches.get(name) ?? "",
    appendSwitch: (name, value = "") => { switches.set(name, value) },
  }
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test("non-Linux platforms never modify password-store switches", () => {
  const path = tempPath()
  writeFileSync(path, JSON.stringify({ useSystemKeyring: false }))
  const commandLine = fakeCommandLine()
  expect(configureLinuxPasswordStore({ platform: "win32", path, commandLine, env: { DESKFLEET_PASSWORD_STORE: "basic" } })).toEqual({ appliedUseSystemKeyring: true })
  expect(commandLine.switches.size).toBe(0)
})

test("Linux startup applies basic password-store when persisted preference disables system keyring", () => {
  const path = tempPath()
  const missingCmd = fakeCommandLine()
  expect(configureLinuxPasswordStore({ platform: "linux", path, commandLine: missingCmd })).toEqual({ appliedUseSystemKeyring: true })
  expect(missingCmd.switches.has("password-store")).toBe(false)

  writeFileSync(path, JSON.stringify({ useSystemKeyring: false }))
  const disabledCmd = fakeCommandLine()
  expect(configureLinuxPasswordStore({ platform: "linux", path, commandLine: disabledCmd })).toEqual({ appliedUseSystemKeyring: false })
  expect(disabledCmd.switches.get("password-store")).toBe("basic")
})

test("CLI --password-store takes precedence over DESKFLEET_PASSWORD_STORE and saved preference", () => {
  const path = tempPath()
  writeFileSync(path, JSON.stringify({ useSystemKeyring: false }))

  const cliCmd = fakeCommandLine({ "password-store": "gnome-libsecret" })
  expect(configureLinuxPasswordStore({
    platform: "linux",
    path,
    commandLine: cliCmd,
    env: { DESKFLEET_PASSWORD_STORE: "basic" },
  })).toEqual({ appliedUseSystemKeyring: true })
  expect(cliCmd.switches.get("password-store")).toBe("gnome-libsecret")

  const envCmd = fakeCommandLine()
  expect(configureLinuxPasswordStore({
    platform: "linux",
    path,
    commandLine: envCmd,
    env: { DESKFLEET_PASSWORD_STORE: "kwallet6" },
  })).toEqual({ appliedUseSystemKeyring: true })
  expect(envCmd.switches.get("password-store")).toBe("kwallet6")

  const warn = vi.fn()
  const invalidEnvCmd = fakeCommandLine()
  expect(configureLinuxPasswordStore({
    platform: "linux",
    path,
    commandLine: invalidEnvCmd,
    env: { DESKFLEET_PASSWORD_STORE: "bogus" },
    warn,
  })).toEqual({ appliedUseSystemKeyring: false })
  expect(warn).toHaveBeenCalledOnce()
  expect(invalidEnvCmd.switches.get("password-store")).toBe("basic")
})

test("corrupt saved preference falls back to system keyring without crashing startup", () => {
  const path = tempPath()
  writeFileSync(path, "{not-json")
  const warn = vi.fn()
  const commandLine = fakeCommandLine()
  expect(configureLinuxPasswordStore({ platform: "linux", path, commandLine, warn })).toEqual({ appliedUseSystemKeyring: true })
  expect(warn).toHaveBeenCalledOnce()
  expect(commandLine.switches.has("password-store")).toBe(false)
})

test("controller persists useSystemKeyring and reports restartRequired against applied startup state", () => {
  const path = tempPath()
  const controller = new LinuxKeyringSettingsController(path, true)
  expect(controller.get()).toEqual({ useSystemKeyring: true, restartRequired: false })
  expect(controller.setUseSystemKeyring(false)).toEqual({ useSystemKeyring: false, restartRequired: true })
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ useSystemKeyring: false })
  expect(controller.setUseSystemKeyring(true)).toEqual({ useSystemKeyring: true, restartRequired: false })

  // After restarting with basic storage applied, reading the saved false value requires no restart.
  controller.setUseSystemKeyring(false)
  const restarted = new LinuxKeyringSettingsController(path, false)
  expect(restarted.get()).toEqual({ useSystemKeyring: false, restartRequired: false })
  expect(restarted.setUseSystemKeyring(true)).toEqual({ useSystemKeyring: true, restartRequired: true })
})
