import { afterEach, expect, test, vi } from "vitest"
import { UpdateController, UPDATE_CHECK_INTERVAL, type UpdateDriver } from "./update-controller.ts"
import type { UpdateState } from "../../../../packages/client/src/updates.ts"

const controllers: UpdateController[] = []
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.close()
  vi.useRealTimers()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function setup() {
  const driver = {
    check: vi.fn<UpdateDriver["check"]>().mockResolvedValue("0.2.0"),
    download: vi.fn<UpdateDriver["download"]>().mockResolvedValue(),
    install: vi.fn<UpdateDriver["install"]>(),
    close: vi.fn(),
  }
  const publish = vi.fn<(state: UpdateState) => void>()
  const beforeInstall = vi.fn<() => Promise<void>>().mockResolvedValue()
  const controller = new UpdateController(driver, publish, beforeInstall)
  controllers.push(controller)
  return { controller, driver, publish, beforeInstall }
}

test("startup checks immediately and every thirty minutes without downloading", async () => {
  vi.useFakeTimers()
  const { controller, driver } = setup()
  controller.start()
  controller.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(driver.check).toHaveBeenCalledTimes(1)
  expect(controller.get()).toEqual({ status: "available", version: "0.2.0" })
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL - 1)
  expect(driver.check).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(driver.check).toHaveBeenCalledTimes(2)
  expect(driver.download).not.toHaveBeenCalled()
  expect(driver.install).not.toHaveBeenCalled()
})

test("unsupported builds do not start timers or allow installation", async () => {
  vi.useFakeTimers()
  const controller = new UpdateController(null, vi.fn(), vi.fn())
  controllers.push(controller)
  controller.start()
  expect(controller.get()).toEqual({ status: "disabled" })
  expect(vi.getTimerCount()).toBe(0)
  await controller.check()
  expect(controller.get()).toEqual({ status: "disabled" })
  await expect(controller.install()).rejects.toThrow("unavailable")
})

test("manual checks share an in-flight check and keep the installed version in snapshots", async () => {
  const checking = deferred<string | null>()
  const driver = {
    check: vi.fn(() => checking.promise), download: vi.fn(), install: vi.fn(), close: vi.fn(),
  }
  const publish = vi.fn()
  const controller = new UpdateController(driver, publish, vi.fn(), "0.1.0")
  controllers.push(controller)
  expect(controller.get()).toEqual({ status: "idle", currentVersion: "0.1.0" })
  const first = controller.check()
  expect(controller.check()).toBe(first)
  expect(controller.get()).toEqual({ status: "checking", currentVersion: "0.1.0" })
  checking.resolve("0.2.0")
  await first
  expect(controller.get()).toEqual({ status: "available", version: "0.2.0", currentVersion: "0.1.0" })
  expect(publish).toHaveBeenLastCalledWith(controller.get())
  expect(driver.check).toHaveBeenCalledOnce()
  expect(driver.download).not.toHaveBeenCalled()
  expect(driver.install).not.toHaveBeenCalled()
})

test("slow checks do not overlap and a failed check keeps the available update without Retry", async () => {
  vi.useFakeTimers()
  const { controller, driver } = setup()
  await controller.check()
  const checking = deferred<string | null>()
  driver.check.mockReturnValueOnce(checking.promise)
  controller.start()
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL)
  expect(driver.check).toHaveBeenCalledTimes(2)
  expect(controller.get()).toEqual({ status: "checking", version: "0.2.0" })
  checking.reject(new Error("Offline"))
  await vi.advanceTimersByTimeAsync(0)
  // Check failures must stay on available: error would show Retry and call install().
  expect(controller.get()).toEqual({ status: "available", version: "0.2.0" })
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL)
  expect(driver.check).toHaveBeenCalledTimes(3)
  expect(controller.get()).toEqual({ status: "available", version: "0.2.0" })
})

test("a failed first check returns to idle instead of an install error", async () => {
  const { controller, driver } = setup()
  driver.check.mockRejectedValueOnce(new Error("Offline"))
  await expect(controller.check()).rejects.toThrow("Offline")
  expect(controller.get()).toEqual({ status: "idle" })
  expect(driver.download).not.toHaveBeenCalled()
})

test("a check failure during an install click still surfaces as an install error", async () => {
  const { controller, driver } = setup()
  await controller.check()
  const checking = deferred<string | null>()
  driver.check.mockReturnValueOnce(checking.promise)
  const check = controller.check()
  const install = controller.install()
  checking.reject(new Error("Offline"))
  await expect(check).rejects.toThrow("Offline")
  await expect(install).rejects.toThrow("Offline")
  expect(controller.get()).toMatchObject({ status: "error", version: "0.2.0", error: "Offline" })
  expect(driver.download).not.toHaveBeenCalled()
})

test("one click downloads, reports bounded progress, and waits for service shutdown before install", async () => {
  const { controller, driver, beforeInstall, publish } = setup()
  await controller.check()
  const downloading = deferred<void>()
  const shutdown = deferred<void>()
  driver.download.mockImplementation(progress => {
    progress(18.9)
    progress(Number.NaN)
    progress(105)
    return downloading.promise
  })
  beforeInstall.mockReturnValue(shutdown.promise)
  const install = controller.install()
  expect(controller.install()).toBe(install)
  expect(driver.download).toHaveBeenCalledOnce()
  expect(publish).toHaveBeenCalledWith({ status: "downloading", version: "0.2.0", percent: 18 })
  expect(controller.get()).toEqual({ status: "downloading", version: "0.2.0", percent: 100 })
  expect(beforeInstall).not.toHaveBeenCalled()
  downloading.resolve()
  await vi.waitFor(() => expect(beforeInstall).toHaveBeenCalledOnce())
  expect(driver.install).not.toHaveBeenCalled()
  shutdown.resolve()
  await install
  expect(driver.install).toHaveBeenCalledOnce()
  expect(controller.get()).toEqual({ status: "installing", version: "0.2.0", percent: 100 })
  await controller.install()
  expect(driver.install).toHaveBeenCalledOnce()
})

test("a click during a periodic check waits for its selected download target", async () => {
  const { controller, driver } = setup()
  await controller.check()
  const checking = deferred<string | null>()
  driver.check.mockReturnValueOnce(checking.promise)
  const check = controller.check()
  const install = controller.install()
  expect(driver.download).not.toHaveBeenCalled()
  checking.resolve("0.3.0")
  await Promise.all([check, install])
  expect(driver.download).toHaveBeenCalledOnce()
  expect(controller.get()).toMatchObject({ status: "installing", version: "0.3.0" })
})

test("a check with no available update removes the prompt and cannot install", async () => {
  const { controller, driver } = setup()
  await controller.check()
  driver.check.mockResolvedValueOnce(null)
  await controller.check()
  expect(controller.get()).toEqual({ status: "idle" })
  await expect(controller.install()).rejects.toThrow("No application update")
  expect(driver.download).not.toHaveBeenCalled()
  expect(driver.install).not.toHaveBeenCalled()
})

test("failed download needs another click and does not shut down services", async () => {
  const { controller, driver, beforeInstall } = setup()
  await controller.check()
  driver.download.mockRejectedValueOnce(new Error("Download interrupted"))
  await expect(controller.install()).rejects.toThrow("Download interrupted")
  expect(controller.get()).toMatchObject({ status: "error", version: "0.2.0", error: "Download interrupted" })
  expect(beforeInstall).not.toHaveBeenCalled()
  expect(driver.install).not.toHaveBeenCalled()
  await controller.install()
  expect(driver.download).toHaveBeenCalledTimes(2)
  expect(driver.install).toHaveBeenCalledOnce()
})

test("shutdown failure prevents installation and retry uses the completed download", async () => {
  const { controller, driver, beforeInstall } = setup()
  await controller.check()
  beforeInstall.mockRejectedValueOnce(new Error("Daemon could not stop"))
  await expect(controller.install()).rejects.toThrow("Daemon could not stop")
  expect(driver.install).not.toHaveBeenCalled()
  await controller.check()
  expect(driver.check).toHaveBeenCalledOnce()
  await controller.install()
  expect(driver.download).toHaveBeenCalledOnce()
  expect(beforeInstall).toHaveBeenCalledTimes(2)
  expect(driver.install).toHaveBeenCalledOnce()
})

test("installer errors are visible and require another explicit click", async () => {
  const { controller, driver } = setup()
  await controller.check()
  await controller.install()
  driver.install.mock.calls[0]![0](new Error("Installer failed"))
  expect(controller.get()).toMatchObject({ status: "error", version: "0.2.0", error: "Installer failed" })
  await controller.install()
  expect(driver.download).toHaveBeenCalledOnce()
  expect(driver.install).toHaveBeenCalledTimes(2)
})

test("checks never run during download or install", async () => {
  vi.useFakeTimers()
  const { controller, driver } = setup()
  controller.start()
  await vi.advanceTimersByTimeAsync(0)
  const downloading = deferred<void>()
  driver.download.mockReturnValue(downloading.promise)
  const install = controller.install()
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL)
  expect(driver.check).toHaveBeenCalledOnce()
  downloading.resolve()
  await install
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL)
  expect(driver.check).toHaveBeenCalledOnce()
})

test("closing cancels timers and ignores late check results", async () => {
  vi.useFakeTimers()
  const { controller, driver, publish } = setup()
  const checking = deferred<string | null>()
  driver.check.mockReturnValue(checking.promise)
  controller.start()
  controller.close()
  controller.close()
  publish.mockClear()
  checking.resolve("0.2.0")
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL)
  expect(publish).not.toHaveBeenCalled()
  expect(driver.check).toHaveBeenCalledOnce()
  expect(driver.close).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

test.each(["download", "shutdown"])("normal quit during %s never installs on completion", async phase => {
  const { controller, driver, beforeInstall, publish } = setup()
  await controller.check()
  const pending = deferred<void>()
  if (phase === "download") driver.download.mockReturnValue(pending.promise)
  else beforeInstall.mockReturnValue(pending.promise)
  const install = controller.install()
  if (phase === "shutdown") await vi.waitFor(() => expect(beforeInstall).toHaveBeenCalledOnce())
  controller.close()
  publish.mockClear()
  pending.resolve()
  await install
  expect(driver.install).not.toHaveBeenCalled()
  expect(publish).not.toHaveBeenCalled()
  if (phase === "download") expect(beforeInstall).not.toHaveBeenCalled()
})
