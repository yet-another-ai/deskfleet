import { join } from "node:path"
import { activeMachineDirectory } from "../../../daemon/src/machine-directory.ts"
import { readWorktreeRoot, writeWorktreeRoot } from "../../../daemon/src/worktree-settings.ts"
import type { WorktreeRootState } from "../../../../packages/client/src/settings.ts"

/** The local daemon reads the same preference before provisioning each Session. */
export class WorktreeRootSettingsController {
  readonly #directory: string

  constructor(directory: string) { this.#directory = directory }

  async get(): Promise<WorktreeRootState> {
    return {
      root: await readWorktreeRoot(this.#directory),
      defaultRoot: join(await activeMachineDirectory(this.#directory), "session-worktrees"),
    }
  }

  async set(root: string | null): Promise<WorktreeRootState> {
    await writeWorktreeRoot(this.#directory, root)
    return this.get()
  }
}
