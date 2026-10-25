import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test, vi } from "vitest"
import { KeepAwakeController } from "./keep-awake.ts"

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "deskfleet-keep-awake-"))
  directories.push(directory)
  const path = join(directory, "preferences", "keep-awake.json")
  let nextId = 0
  const blocker = { start: vi.fn(() => nextId++), stop: vi.fn(() => true) }
  return { path, blocker, controller: new KeepAwakeController(path, blocker) }
}

test("defaults off and keeps a single sleep blocker until disabled", async () => {
  const { path, blocker, controller } = await fixture()
  expect(controller.get()).toEqual({ enabled: false })
  expect(blocker.start).not.toHaveBeenCalled()
  expect(controller.setEnabled(true)).toEqual({ enabled: true })
  expect(controller.get()).toEqual({ enabled: true })
  expect(controller.setEnabled(true)).toEqual({ enabled: true })
  expect(blocker.start).toHaveBeenCalledExactlyOnceWith("prevent-app-suspension")
  expect(controller.setEnabled(false)).toEqual({ enabled: false })
  expect(blocker.stop).toHaveBeenCalledExactlyOnceWith(0)
  controller.close()
  expect(blocker.stop).toHaveBeenCalledOnce()
  expect(new KeepAwakeController(path, blocker).get()).toEqual({ enabled: false })
  expect(blocker.start).toHaveBeenCalledOnce()
})

test("restores the saved preference at startup and preserves it when quitting", async () => {
  const { path, blocker, controller } = await fixture()
  controller.setEnabled(true)
  controller.close()
  controller.close()
  expect(blocker.stop).toHaveBeenCalledExactlyOnceWith(0)
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ enabled: true })
  const next = new KeepAwakeController(path, blocker)
  expect(next.get()).toEqual({ enabled: true })
  expect(blocker.start).toHaveBeenCalledTimes(2)
  next.close()
  expect(blocker.stop).toHaveBeenLastCalledWith(1)
})

test.each([false, true])("a failed save preserves the previous setting enabled=%s", async (enabled) => {
  const { path, blocker, controller } = await fixture()
  controller.setEnabled(enabled)
  // Fail the atomic rename after the new blocker state has been applied.
  await rm(path)
  await mkdir(path)
  expect(() => controller.setEnabled(!enabled)).toThrow()
  expect(controller.get()).toEqual({ enabled })
  if (enabled) {
    expect(blocker.stop).toHaveBeenCalledExactlyOnceWith(0)
    expect(blocker.start).toHaveBeenCalledTimes(2)
  } else {
    expect(blocker.start).toHaveBeenCalledOnce()
    expect(blocker.stop).toHaveBeenCalledExactlyOnceWith(0)
  }
  await rm(path, { recursive: true })
  expect(controller.setEnabled(!enabled)).toEqual({ enabled: !enabled })
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ enabled: !enabled })
  controller.close()
})

test("a failed blocker request leaves the saved preference unchanged", async () => {
  const { path, blocker, controller } = await fixture()
  controller.setEnabled(false)
  blocker.start.mockImplementationOnce(() => { throw new Error("Power management unavailable") })
  expect(() => controller.setEnabled(true)).toThrow("Power management unavailable")
  expect(controller.get()).toEqual({ enabled: false })
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ enabled: false })
})

test("invalid persisted settings are reported and can be reloaded", async () => {
  const { path, blocker, controller } = await fixture()
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, '{"enabled":"true"}')
  expect(() => controller.get()).toThrow("Invalid Keep Awake settings")
  expect(blocker.start).not.toHaveBeenCalled()
  await writeFile(path, '{"enabled":true}')
  expect(controller.get()).toEqual({ enabled: true })
  controller.close()
})
