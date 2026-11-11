import { beforeEach, expect, test, vi } from "vitest"

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }))
vi.mock("node:child_process", () => ({ execFile }))
import { AuvPermissionsController } from "./auv-permissions-controller.ts"

type Completed = (error: Error | null, stdout: string, stderr: string) => void
type ExecutionOptions = { signal: AbortSignal }
const binary = "/Desk Fleet/resources/bin/auv"
const report = {
  app_id: "ai.moeru.auv", desktop_entry_installed: true, identity_registered: true, identity_error: null,
  capture_token_present: true, input_token_present: true,
}

function respond(value: unknown): void {
  execFile.mockImplementation((_binary, _args, _options, complete: Completed) => complete(null, JSON.stringify(value), ""))
}

beforeEach(() => { execFile.mockReset() })

test("silent checks use only doctor diagnostics and recognize saved screen and input authorization", async () => {
  respond(report)
  await expect(new AuvPermissionsController(binary).get()).resolves.toEqual({ status: "saved" })
  expect(execFile).toHaveBeenCalledExactlyOnceWith(binary, ["doctor", "--json"], {
    encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024, timeout: 30_000, signal: expect.any(AbortSignal),
  }, expect.any(Function))
})

test.each([
  { capture_token_present: false, input_token_present: false },
  { capture_token_present: true, input_token_present: false },
  { capture_token_present: false, input_token_present: true },
])("partial or absent saved tokens need authorization: %j", async tokens => {
  respond({ ...report, ...tokens })
  await expect(new AuvPermissionsController(binary).get()).resolves.toEqual({ status: "not-requested" })
})

test.each([
  { desktop_entry_installed: false },
  { identity_registered: false, identity_error: "App info not found" },
  { identity_error: "Registration failed" },
])("saved tokens do not hide an invalid desktop identity: %j", async identity => {
  respond({ ...report, ...identity })
  await expect(new AuvPermissionsController(binary).get()).resolves.toEqual({
    status: "error", error: "AUV's desktop identity is not registered. Request authorization to set it up.",
  })
})

test.each(["screencast", "remote_desktop"])("missing %s Portal is reported even when token files exist", async name => {
  respond({ ...report, interfaces: { [name]: { available: "missing" } } })
  await expect(new AuvPermissionsController(binary).get()).resolves.toMatchObject({ status: "error", error: expect.stringContaining("Portals") })
})

test.each([null, [], { ...report, app_id: "another.app" }, { ...report, capture_token_present: "true" }, { ...report, identity_error: undefined }])(
  "invalid doctor reports never claim saved authorization: %j", async value => {
    respond(value)
    await expect(new AuvPermissionsController(binary).get()).resolves.toMatchObject({ status: "error", error: expect.stringContaining("invalid authorization report") })
  },
)

test("malformed diagnostic JSON and command failures become error states without leaking output", async () => {
  const controller = new AuvPermissionsController(binary)
  execFile.mockImplementation((_binary, _args, _options, complete: Completed) => complete(null, "private-token-not-json", ""))
  await expect(controller.get()).resolves.toEqual({ status: "error", error: "AUV returned an invalid authorization report. Try again." })
  execFile.mockImplementation((_binary, _args, _options, complete: Completed) => complete(new Error("private-token-in-process-output"), "", ""))
  await expect(controller.get()).resolves.toEqual({ status: "error", error: "Could not check AUV authorization. Try again." })
})

test("request installs identity and asks AUV to persist both Portal permissions", async () => {
  respond(report)
  await expect(new AuvPermissionsController(binary).request()).resolves.toEqual({ status: "saved" })
  expect(execFile).toHaveBeenCalledExactlyOnceWith(binary, ["doctor", "--portal-setup", "--portal-authorize", "--json"], {
    encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024, timeout: 150_000, signal: expect.any(AbortSignal),
  }, expect.any(Function))
})

test.each([
  { capture_token_present: false, input_token_present: false },
  { capture_token_present: true, input_token_present: false },
  { capture_token_present: false, input_token_present: true },
])("successful consent without reusable tokens reports the persistence limit: %j", async tokens => {
  respond({ ...report, ...tokens })
  await expect(new AuvPermissionsController(binary).request()).resolves.toMatchObject({
    status: "error", error: expect.stringContaining("desktop did not save screen and input authorization"),
  })
})

test("cancelled authorization can be retried", async () => {
  const controller = new AuvPermissionsController(binary)
  execFile.mockImplementation((_binary, _args, _options, complete: Completed) => complete(new Error("Portal request cancelled"), "", ""))
  await expect(controller.request()).resolves.toEqual({
    status: "error", error: "AUV authorization did not complete. Approve the desktop prompts and try again.",
  })
  respond(report)
  await expect(controller.request()).resolves.toEqual({ status: "saved" })
  expect(execFile).toHaveBeenCalledTimes(2)
})

test("duplicate requests share consent and checks report requesting while it is pending", async () => {
  let complete!: Completed
  execFile.mockImplementation((_binary, _args, _options, callback: Completed) => { complete = callback })
  const controller = new AuvPermissionsController(binary)
  const first = controller.request()
  const second = controller.request()
  expect(second).toBe(first)
  await expect(controller.get()).resolves.toEqual({ status: "requesting" })
  expect(execFile).toHaveBeenCalledTimes(1)
  complete(null, JSON.stringify(report), "")
  await expect(first).resolves.toEqual({ status: "saved" })
  respond({ ...report, capture_token_present: false })
  await expect(controller.get()).resolves.toEqual({ status: "not-requested" })
})

test("closing aborts in-flight checks and consent and prevents more helpers from launching", async () => {
  const signals: AbortSignal[] = []
  execFile.mockImplementation((_binary, _args, options: ExecutionOptions, complete: Completed) => {
    signals.push(options.signal)
    options.signal.addEventListener("abort", () => complete(new Error("aborted"), "", ""), { once: true })
  })
  const controller = new AuvPermissionsController(binary)
  const check = controller.get()
  const request = controller.request()
  controller.close()
  expect(signals).toHaveLength(2)
  expect(signals.every(signal => signal.aborted)).toBe(true)
  const closed = { status: "error", error: "AUV authorization is unavailable because the application is closing." }
  await expect(check).resolves.toEqual(closed)
  await expect(request).resolves.toEqual(closed)
  await expect(controller.get()).resolves.toEqual(closed)
  await expect(controller.request()).resolves.toEqual(closed)
  expect(execFile).toHaveBeenCalledTimes(2)
})
