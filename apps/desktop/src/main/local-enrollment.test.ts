import { expect, test, vi } from "vitest"
import type { CentralApi, LocalEnrollment } from "@deskfleet/client/central"
import { enrollLocalMachine } from "./local-enrollment.ts"

function setup(revoked: boolean, configured = true) {
  const current: LocalEnrollment = { configured, connected: false, revoked, teamId: "original-team", identity: { originId: "old-origin", machineId: "1" }, machineName: "My computer" }
  const fresh: LocalEnrollment = { configured: false, connected: false, revoked: false, identity: { originId: "fresh-origin", machineId: "1" }, machineName: "My computer" }
  const local = { status: vi.fn(async () => current), prepare: vi.fn(async () => fresh), enroll: vi.fn(async () => ({ ...fresh, configured: true, teamId: "original-team", machineId: "new-machine" })) }
  const central = { status: vi.fn(async () => ({ serverUrl: "https://fleet.example" })), enrollHeadless: vi.fn(async () => ({ machine: { id: "new-machine" }, token: "one-time-credential" })) } as unknown as Pick<CentralApi, "status" | "enrollHeadless">
  return { current, fresh, local, central }
}

test("re-registers a revoked machine into the original team using only its fresh identity", async () => {
  const f = setup(true)
  const result = await enrollLocalMachine(f.central, f.local, "original-team")
  expect(f.local.prepare).toHaveBeenCalledOnce()
  expect(f.central.enrollHeadless).toHaveBeenCalledExactlyOnceWith("original-team", { name: "My computer", originId: "fresh-origin", localMachineId: "1" })
  expect(f.local.enroll).toHaveBeenCalledExactlyOnceWith({ serverUrl: "https://fleet.example", teamId: "original-team", machineId: "new-machine", token: "one-time-credential" })
  expect(result.configured).toBe(true)
})

test("the chosen Team name replaces the hostname, which remains the default", async () => {
  const f = setup(false, false)
  await enrollLocalMachine(f.central, f.local, "original-team", "  Design MacBook  ")
  expect(vi.mocked(f.central.enrollHeadless).mock.calls[0]![1].name).toBe("Design MacBook")
  await enrollLocalMachine(f.central, f.local, "original-team", "   ")
  expect(vi.mocked(f.central.enrollHeadless).mock.calls[1]![1].name).toBe("My computer")
  await expect(enrollLocalMachine(f.central, f.local, "original-team", 42)).rejects.toThrow("Invalid machine name")
  expect(f.central.enrollHeadless).toHaveBeenCalledTimes(2)
})

test("an active registration cannot be overwritten", async () => {
  const f = setup(false)
  await expect(enrollLocalMachine(f.central, f.local, "other-team")).rejects.toThrow("already enrolled")
  expect(f.local.prepare).not.toHaveBeenCalled()
  expect(f.central.enrollHeadless).not.toHaveBeenCalled()
})

test("a failed fresh registration retries the prepared identity without resetting again", async () => {
  const f = setup(true)
  vi.mocked(f.central.enrollHeadless).mockRejectedValueOnce(new Error("Network unavailable"))
  await expect(enrollLocalMachine(f.central, f.local, "original-team")).rejects.toThrow("Network unavailable")
  expect(f.local.enroll).not.toHaveBeenCalled()
  f.local.status.mockResolvedValue(f.fresh)
  await enrollLocalMachine(f.central, f.local, "original-team")
  expect(f.local.prepare).toHaveBeenCalledOnce()
  expect(f.central.enrollHeadless).toHaveBeenCalledTimes(2)
  for (const [, registration] of vi.mocked(f.central.enrollHeadless).mock.calls) expect(registration.originId).toBe("fresh-origin")
})
