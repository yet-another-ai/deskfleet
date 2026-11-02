import { expect, test, vi } from "vitest"
import type { CentralApi, LocalEnrollment } from "@deskfleet/client/central"
import { enrollLocalMachine } from "./local-enrollment.ts"

function setup(revoked = false, configured = true) {
  const current: LocalEnrollment = { configured, connected: false, revoked, serverUrl: "https://fleet.example", teamId: "original-team", machineId: "same-machine", identity: { originId: "old-origin", machineId: "1" }, machineName: "My computer" }
  const fresh = { configured: false, connected: false, revoked: false, identity: { originId: "fresh-origin", machineId: "1" }, machineName: "My computer", identityToken: "host-identity-secret" }
  const local = {
    status: vi.fn(async () => ({ machineName: current.machineName, registrations: configured ? [current] : [] })),
    prepare: vi.fn(async ({ teamId }: { serverUrl: string; teamId: string }) => teamId === current.teamId && configured ? { ...current, identityToken: fresh.identityToken } : fresh),
    enroll: vi.fn(async () => ({ ...fresh, configured: true, teamId: "original-team", machineId: "same-machine" })),
  }
  const central = { status: vi.fn(async () => ({ serverUrl: "https://fleet.example" })), enrollHeadless: vi.fn(async () => ({ machine: { id: "same-machine" }, token: "team-credential" })) } as unknown as Pick<CentralApi, "status" | "enrollHeadless">
  return { current, fresh, local, central }
}

test("restores a revoked Team registration with its existing catalog and stable Machine ID", async () => {
  const f = setup(true)
  const result = await enrollLocalMachine(f.central, f.local, "original-team")
  expect(f.local.prepare).toHaveBeenCalledExactlyOnceWith({ serverUrl: "https://fleet.example", teamId: "original-team" })
  expect(f.central.enrollHeadless).toHaveBeenCalledExactlyOnceWith("original-team", { name: "My computer", originId: "old-origin", localMachineId: "1", identityToken: "host-identity-secret" })
  expect(f.local.enroll).toHaveBeenCalledExactlyOnceWith({ serverUrl: "https://fleet.example", teamId: "original-team", machineId: "same-machine", token: "team-credential", originId: "old-origin" })
  expect(result.machineId).toBe("same-machine")
})

test("joining another Team prepares an independent catalog without replacing the active registration", async () => {
  const f = setup()
  await enrollLocalMachine(f.central, f.local, "other-team")
  expect(f.central.enrollHeadless).toHaveBeenCalledExactlyOnceWith("other-team", { name: "My computer", originId: "fresh-origin", localMachineId: "1", identityToken: "host-identity-secret" })
  expect(f.current.configured).toBe(true)
  expect(f.current.revoked).toBe(false)
})

test("joining the same active Team returns its existing registration without rotating credentials", async () => {
  const f = setup()
  expect(await enrollLocalMachine(f.central, f.local, "original-team")).toEqual(f.current)
  expect(f.local.prepare).not.toHaveBeenCalled()
  expect(f.central.enrollHeadless).not.toHaveBeenCalled()
})

test("the Team display name defaults to the hostname and rejects non-text IPC input", async () => {
  const f = setup(false, false)
  await enrollLocalMachine(f.central, f.local, "original-team", "  Design MacBook  ")
  expect(vi.mocked(f.central.enrollHeadless).mock.calls[0]![1].name).toBe("Design MacBook")
  await enrollLocalMachine(f.central, f.local, "original-team", "   ")
  expect(vi.mocked(f.central.enrollHeadless).mock.calls[1]![1].name).toBe("My computer")
  await expect(enrollLocalMachine(f.central, f.local, "original-team", 42)).rejects.toThrow("Invalid machine name")
})

test("a failed enrollment retries the prepared Team identity", async () => {
  const f = setup(false, false)
  vi.mocked(f.central.enrollHeadless).mockRejectedValueOnce(new Error("Network unavailable"))
  await expect(enrollLocalMachine(f.central, f.local, "original-team")).rejects.toThrow("Network unavailable")
  expect(f.local.enroll).not.toHaveBeenCalled()
  await enrollLocalMachine(f.central, f.local, "original-team")
  for (const [, registration] of vi.mocked(f.central.enrollHeadless).mock.calls) expect(registration.originId).toBe("fresh-origin")
})
