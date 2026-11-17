import { readWorktreeRoot, writeWorktreeRoot } from "../../../daemon/src/worktree-settings.ts"
import { readWorktreePreferences, writeWorktreePreferences, type WorktreePreferences } from "../../../daemon/src/worktree-preferences.ts"
import type { WorktreeRootState } from "../../../../packages/client/src/settings.ts"

/** The local daemon reads the same preference before provisioning each Session. */
export class WorktreeRootSettingsController {
  readonly #directory: string
  readonly #defaultRoot: string

  constructor(directory: string, defaultRoot = directory) {
    this.#directory = directory
    this.#defaultRoot = defaultRoot
  }

  getPreferences(): Promise<WorktreePreferences> {
    return readWorktreePreferences(this.#directory)
  }

  async setPreferences(preferences: WorktreePreferences): Promise<WorktreePreferences> {
    await writeWorktreePreferences(this.#directory, preferences)
    return this.getPreferences()
  }

  async get(): Promise<WorktreeRootState> {
    return {
      root: await readWorktreeRoot(this.#directory),
      defaultRoot: this.#defaultRoot,
    }
  }

  async set(root: string | null): Promise<WorktreeRootState> {
    await writeWorktreeRoot(this.#directory, root)
    return this.get()
  }
}
