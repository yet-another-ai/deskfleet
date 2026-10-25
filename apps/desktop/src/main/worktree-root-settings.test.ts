import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "vitest"
import { readWorktreeRoot } from "../../../daemon/src/worktree-settings.ts"
import { WorktreeRootSettingsController } from "./worktree-root-settings.ts"

const directories: string[] = []
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }) })

test("desktop saves the daemon's preference and resolves the active machine's default", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deskfleet-worktree-settings-"))
  directories.push(directory)
  const controller = new WorktreeRootSettingsController(directory)
  const original = { root: null, defaultRoot: join(directory, "machine", "session-worktrees") }
  expect(await controller.get()).toEqual(original)
  const selected = await controller.set(join(directory, "other-disk"))
  expect(selected.root).toBe(await readWorktreeRoot(directory))
  expect(await new WorktreeRootSettingsController(directory).get()).toEqual(selected)
  expect(await controller.set(null)).toEqual(original)
  const machine = "machines/12345678-1234-1234-1234-123456789abc"
  await writeFile(join(directory, "active-machine.json"), JSON.stringify({ directory: machine }))
  expect(await controller.get()).toEqual({ root: null, defaultRoot: join(directory, machine, "session-worktrees") })
})
