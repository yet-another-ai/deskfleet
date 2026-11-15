import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const { emit, startRestart } = vi.hoisted(() => ({ emit: vi.fn(), startRestart: vi.fn() }))
vi.mock("electron", () => ({ autoUpdater: { emit } }))
vi.mock("./appimage-restart.ts", () => ({ startAppImageRestart: startRestart }))
import { RestartingAppImageUpdater } from "./appimage-updater.ts"

const directories: string[] = []

beforeEach(() => {
  vi.clearAllMocks()
  startRestart.mockReset().mockResolvedValue(true)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

class StagedUpdater extends RestartingAppImageUpdater {
  stage(file: string): void {
    // Stand in for downloadUpdate(); installation uses the actual upstream
    // installer so destination naming and the spawn hook are exercised together.
    this.downloadedUpdateHelper = {
      file, downloadedFileInfo: { fileName: file, sha512: "fixture", isAdminRightsRequired: false },
    } as NonNullable<typeof this.downloadedUpdateHelper>
  }

  get installing(): boolean { return this.quitAndInstallCalled }
}

function fixture(name = "deskfleet-0.1.0.AppImage") {
  const directory = mkdtempSync(join(tmpdir(), "deskfleet-appimage-updater-"))
  directories.push(directory)
  const current = join(directory, name)
  const pending = join(directory, "pending")
  mkdirSync(pending)
  const downloaded = join(pending, "deskfleet-0.2.0.AppImage")
  writeFileSync(current, "old app")
  writeFileSync(downloaded, "new app")
  vi.stubEnv("APPIMAGE", current)
  const app = { version: "0.1.0", quit: vi.fn() }
  const updater = new StagedUpdater(null, app)
  updater.logger = null
  updater.stage(downloaded)
  const failed = vi.fn()
  updater.on("error", failed)
  return { updater, app, failed, current, downloaded, directory }
}

async function flushQuit(): Promise<void> {
  await Promise.resolve()
  await new Promise<void>(resolve => setImmediate(resolve))
}

describe.skipIf(process.platform !== "linux")("AppImage install and restart handoff", () => {
  test.each(["deskfleet-0.1.0.AppImage", "My DeskFleet.AppImage"])("installs %s and waits for supervisor startup before quitting", async name => {
    const f = fixture(name)
    let ready!: (value: boolean) => void
    startRestart.mockReturnValueOnce(new Promise<boolean>(resolve => { ready = resolve }))
    const flags = ["--ozone-platform=wayland", "argument with spaces", "$(literal)"]
    vi.stubGlobal("process", { ...process, argv: [process.execPath, ...flags] })

    f.updater.quitAndInstall(false, true)

    const destination = name === "My DeskFleet.AppImage" ? f.current : join(f.directory, "deskfleet-0.2.0.AppImage")
    expect(readFileSync(destination, "utf8")).toBe("new app")
    expect(existsSync(f.downloaded)).toBe(false)
    if (destination !== f.current) expect(existsSync(f.current)).toBe(false)
    expect(startRestart).toHaveBeenCalledExactlyOnceWith(destination, flags, expect.objectContaining({
      APPIMAGE: f.current, APPIMAGE_SILENT_INSTALL: "true",
    }))
    await flushQuit()
    expect(emit).not.toHaveBeenCalled()
    expect(f.app.quit).not.toHaveBeenCalled()

    ready(true)
    await flushQuit()
    expect(emit).toHaveBeenCalledExactlyOnceWith("before-quit-for-update")
    expect(f.app.quit).toHaveBeenCalledOnce()
    expect(emit.mock.invocationCallOrder[0]).toBeLessThan(f.app.quit.mock.invocationCallOrder[0]!)
    expect(f.failed).not.toHaveBeenCalled()
  })

  test("supervisor spawn failure reports one installer error and keeps the current app open", async () => {
    const f = fixture()
    const error = new Error("Cannot start restart supervisor")
    startRestart.mockRejectedValueOnce(error)

    f.updater.quitAndInstall(false, true)
    await flushQuit()

    expect(f.failed).toHaveBeenCalledOnce()
    expect(f.failed.mock.calls[0]![0]).toBe(error)
    expect(f.app.quit).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
    expect(f.updater.installing).toBe(false)
  })

  test("file replacement failure never starts the supervisor or quits", async () => {
    const f = fixture()
    rmSync(f.current)

    f.updater.quitAndInstall(false, true)
    await flushQuit()

    expect(f.failed).toHaveBeenCalledOnce()
    expect(startRestart).not.toHaveBeenCalled()
    expect(f.app.quit).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
    expect(f.updater.installing).toBe(false)
  })

  test("duplicate installation calls keep a single pending restart and quit once", async () => {
    const f = fixture()
    let ready!: (value: boolean) => void
    startRestart.mockReturnValueOnce(new Promise<boolean>(resolve => { ready = resolve }))

    f.updater.quitAndInstall(false, true)
    f.updater.quitAndInstall(false, true)
    expect(startRestart).toHaveBeenCalledOnce()
    expect(f.updater.installing).toBe(true)
    ready(true)
    await flushQuit()
    f.updater.quitAndInstall(false, true)
    await flushQuit()

    expect(startRestart).toHaveBeenCalledOnce()
    expect(f.app.quit).toHaveBeenCalledOnce()
    expect(f.failed).not.toHaveBeenCalled()
  })
})
