import { join } from "node:path"
import { afterEach, beforeEach, expect, test, vi } from "vitest"

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }))
vi.mock("node:child_process", () => ({ execFile }))
import { prepareAuv } from "./auv.ts"

type Completed = (error: Error | null, stdout: string, stderr: string) => void
const paths = { appPath: "/Desk Fleet/app", resourcesPath: "/Desk Fleet/resources" }

beforeEach(() => { execFile.mockReset() })
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

test.each([false, true])("Linux waits for Portal identity setup before exposing the bundled binary (packaged=%s)", async isPackaged => {
  vi.stubGlobal("process", { ...process, platform: "linux" })
  let complete!: Completed
  execFile.mockImplementation((_binary, _args, _options, callback: Completed) => { complete = callback })
  const binary = isPackaged
    ? join(paths.resourcesPath, "bin", "auv")
    : join(paths.appPath, "out", "auv", "auv")
  let prepared = false
  const result = prepareAuv({ ...paths, isPackaged }).then(path => { prepared = true; return path })
  await Promise.resolve()
  expect(prepared).toBe(false)
  expect(execFile).toHaveBeenCalledExactlyOnceWith(binary, ["doctor", "--portal-setup"], {
    timeout: 10_000, windowsHide: true,
  }, expect.any(Function))
  complete(null, "Portal desktop entry installed\n", "")
  await expect(result).resolves.toBe(binary)
})

test("a failed Portal setup is reported without preventing the rest of the app from starting", async () => {
  vi.stubGlobal("process", { ...process, platform: "linux" })
  const error = new Error("Cannot write desktop entry")
  const report = vi.spyOn(console, "error").mockImplementation(() => {})
  execFile.mockImplementation((_binary, _args, _options, callback: Completed) => callback(error, "", ""))
  await expect(prepareAuv({ ...paths, isPackaged: true })).resolves.toBe(join(paths.resourcesPath, "bin", "auv"))
  expect(report).toHaveBeenCalledExactlyOnceWith("Could not set up AUV Portal identity", error)
})

test.each([
  { platform: "win32", isPackaged: true, binary: join(paths.resourcesPath, "bin", "auv.exe") },
  { platform: "win32", isPackaged: false, binary: join(paths.appPath, "out", "auv", "auv.exe") },
  { platform: "darwin", isPackaged: true, binary: join(paths.resourcesPath, "..", "MacOS", "auv") },
  { platform: "darwin", isPackaged: false, binary: join(paths.appPath, "out", "auv", "auv") },
])("$platform resolves its bundled binary without Portal setup (packaged=$isPackaged)", async ({ platform, isPackaged, binary }) => {
  vi.stubGlobal("process", { ...process, platform })
  await expect(prepareAuv({ ...paths, isPackaged })).resolves.toBe(binary)
  expect(execFile).not.toHaveBeenCalled()
})
