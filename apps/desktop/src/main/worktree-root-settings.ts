import { readWorktreeRoot, writeWorktreeRoot } from "../../../daemon/src/worktree-settings.ts"
import type { WorktreeRootState } from "../../../../packages/client/src/settings.ts"

/** The local daemon reads the same preference before provisioning each Session. */
export class WorktreeRootSettingsController {
  readonly #directory: string

  constructor(directory: string) { this.#directory = directory }

  async get(): Promise<WorktreeRootState> {
    return {
      root: await readWorktreeRoot(this.#directory),
      // Existing machine/ and newer machines/<id>/ catalogs each keep their own
      // session-worktrees directory. Show their common parent, not one Team.
      defaultRoot: this.#directory,
    }
  }

  async set(root: string | null): Promise<WorktreeRootState> {
    await writeWorktreeRoot(this.#directory, root)
    return this.get()
  }
}
