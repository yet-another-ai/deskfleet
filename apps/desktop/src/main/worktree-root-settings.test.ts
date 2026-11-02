import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "vitest"
import { readWorktreeRoot } from "../../../daemon/src/worktree-settings.ts"
import { WorktreeRootSettingsController } from "./worktree-root-settings.ts"

const directories: string[] = []
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }) })

test("desktop saves the daemon's preference and shows the common parent of all Team defaults", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deskfleet-worktree-settings-"))
  directories.push(directory)
  const controller = new WorktreeRootSettingsController(directory)
  const original = { root: null, defaultRoot: directory }
  expect(await controller.get()).toEqual(original)
  const selected = await controller.set(join(directory, "other-disk"))
  expect(selected.root).toBe(await readWorktreeRoot(directory))
  expect(await new WorktreeRootSettingsController(directory).get()).toEqual(selected)
  expect(await controller.set(null)).toEqual(original)
})
