import { expect, test, vi } from "vitest"
import type { AccountState, LocalEnrollment } from "@deskfleet/client/central"
import type { FileTarget } from "@deskfleet/client/files"
import { isLocalFileTarget } from "./files-local.ts"

const target: FileTarget = { kind: "machine", teamId: "team", machineId: "registered-local" }

function fixture() {
  const account: AccountState = { serverUrl: "https://fleet.example", user: { id: "user", name: "User" }, siteAdmin: false }
  const local: LocalEnrollment = {
    configured: true, connected: false, revoked: false, serverUrl: account.serverUrl,
    teamId: "team", machineId: "registered-local", machineName: "This computer",
    identity: { originId: "local-origin", machineId: "1" },
  }
  const central = { status: vi.fn(async () => account) }
  const enrollment = vi.fn(async () => ({ machineName: local.machineName, registrations: [local] }))
  return { account, local, central, enrollment }
}

test("local file targets do not require an account or daemon discovery", async () => {
  const f = fixture()
  expect(await isLocalFileTarget(f.central, f.enrollment, { kind: "local", grantId: "grant" })).toBe(true)
  expect(f.central.status).not.toHaveBeenCalled()
  expect(f.enrollment).not.toHaveBeenCalled()
})

test("the current Team's registered local machine stays local independently of presence", async () => {
  const f = fixture()
  expect(await isLocalFileTarget(f.central, f.enrollment, target)).toBe(true)
})

test.each(["server", "team", "machine", "database-id", "unconfigured", "revoked", "signed-out"])("%s does not qualify a machine target as local", async reason => {
  const f = fixture()
  if (reason === "server") f.local.serverUrl = "https://another.example"
  if (reason === "team") f.local.teamId = "another-team"
  if (reason === "machine") f.local.machineId = "remote-machine"
  if (reason === "database-id") f.local.machineId = "1"
  if (reason === "unconfigured") f.local.configured = false
  if (reason === "revoked") f.local.revoked = true
  if (reason === "signed-out") delete f.account.user
  expect(await isLocalFileTarget(f.central, f.enrollment, target)).toBe(false)
})

test("a machine without a local registration retains remote behavior", async () => {
  const f = fixture()
  f.enrollment.mockResolvedValue({ machineName: f.local.machineName, registrations: [] })
  expect(await isLocalFileTarget(f.central, f.enrollment, target)).toBe(false)
})

test.each(["account", "discovery"])("failed %s lookup retains remote behavior", async source => {
  const f = fixture()
  if (source === "account") f.central.status.mockRejectedValue(new Error("Account unavailable"))
  else f.enrollment.mockRejectedValue(new Error("Daemon unavailable"))
  await expect(isLocalFileTarget(f.central, f.enrollment, target)).resolves.toBe(false)
})
