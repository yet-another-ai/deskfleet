import { afterEach, expect, test, vi } from "vitest"
import { UpdateController, UPDATE_NETWORK_CHECK_INTERVAL, type UpdateDriver } from "./update-controller.ts"

const controllers: UpdateController[] = []
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.close()
  vi.useRealTimers()
})

function setup(metered = true) {
  vi.useFakeTimers()
  const network = vi.fn(async () => metered)
  const driver = {
    check: vi.fn(async () => "0.2.0"),
    download: vi.fn<UpdateDriver["download"]>().mockResolvedValue(),
    install: vi.fn(), close: vi.fn(),
  }
  const beforeInstall = vi.fn(async () => {})
  const controller = new UpdateController(driver, vi.fn(), beforeInstall, undefined, true, network)
  controllers.push(controller)
  return { controller, driver, network, beforeInstall }
}

test("metered connections defer automatic downloads by default and resume when unmetered", async () => {
  const { controller, driver, network, beforeInstall } = setup()
  controller.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(controller.get()).toEqual({ status: "available", version: "0.2.0" })
  expect(driver.download).not.toHaveBeenCalled()
  network.mockResolvedValue(false)
  await vi.advanceTimersByTimeAsync(UPDATE_NETWORK_CHECK_INTERVAL)
  expect(driver.download).toHaveBeenCalledOnce()
  expect(controller.get().status).toBe("downloaded")
  expect(beforeInstall).not.toHaveBeenCalled()
})

test("turning off the metered preference downloads an already available update", async () => {
  const { controller, driver } = setup()
  controller.start()
  await vi.advanceTimersByTimeAsync(0)
  controller.setDownloadPreferences(true, false)
  await vi.advanceTimersByTimeAsync(0)
  expect(driver.download).toHaveBeenCalledOnce()
  expect(controller.get().status).toBe("downloaded")
})

test("a switch to metered cancels an active background transfer and unmetered resumes it", async () => {
  const { controller, driver, network } = setup(false)
  let signal: AbortSignal | undefined
  driver.download.mockImplementationOnce((_progress, downloadSignal) => {
    signal = downloadSignal
    return new Promise((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true })
    })
  })
  controller.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(controller.get().status).toBe("downloading")
  network.mockResolvedValue(true)
  await vi.advanceTimersByTimeAsync(UPDATE_NETWORK_CHECK_INTERVAL)
  expect(signal?.aborted).toBe(true)
  expect(controller.get()).toEqual({ status: "available", version: "0.2.0" })
  await vi.advanceTimersByTimeAsync(UPDATE_NETWORK_CHECK_INTERVAL)
  expect(driver.download).toHaveBeenCalledOnce()
  network.mockResolvedValue(false)
  await vi.advanceTimersByTimeAsync(UPDATE_NETWORK_CHECK_INTERVAL)
  expect(driver.download).toHaveBeenCalledTimes(2)
  expect(controller.get().status).toBe("downloaded")
})

test("manual installation can download on a metered connection", async () => {
  const { controller, driver, beforeInstall } = setup()
  controller.start()
  await vi.advanceTimersByTimeAsync(0)
  await controller.install()
  expect(driver.download).toHaveBeenCalledExactlyOnceWith(expect.any(Function), undefined)
  expect(driver.install).toHaveBeenCalledOnce()
  expect(beforeInstall).toHaveBeenCalledOnce()
})

test("manual installation joining a background download is not canceled on a network change", async () => {
  const { controller, driver, network } = setup(false)
  let finish!: () => void
  driver.download.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  controller.start()
  await vi.advanceTimersByTimeAsync(0)
  const installing = controller.install()
  network.mockResolvedValue(true)
  await vi.advanceTimersByTimeAsync(UPDATE_NETWORK_CHECK_INTERVAL)
  expect(driver.download.mock.calls[0]![1]?.aborted).toBe(false)
  finish()
  await installing
  expect(driver.install).toHaveBeenCalledOnce()
})

test("enabling metered protection during a transfer applies the new preference immediately", async () => {
  const { controller, driver } = setup()
  driver.download.mockImplementationOnce((_progress, signal) => new Promise((_resolve, reject) => {
    signal!.addEventListener("abort", () => reject(signal!.reason), { once: true })
  }))
  controller.setDownloadPreferences(true, false)
  controller.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(controller.get().status).toBe("downloading")
  controller.setDownloadPreferences(true, true)
  await vi.advanceTimersByTimeAsync(0)
  expect(controller.get().status).toBe("available")
  expect(driver.download.mock.calls[0]![1]?.aborted).toBe(true)
})

test("disabling automatic downloads while a network query is pending prevents the download", async () => {
  const { controller, driver, network } = setup()
  let finish!: (metered: boolean) => void
  network.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  controller.start()
  await vi.advanceTimersByTimeAsync(0)
  controller.setAutoDownload(false)
  finish(false)
  await vi.advanceTimersByTimeAsync(0)
  expect(controller.get().status).toBe("available")
  expect(driver.download).not.toHaveBeenCalled()
})
