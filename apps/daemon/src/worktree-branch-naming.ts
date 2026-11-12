import type { ContentBlock } from "@agentclientprotocol/sdk/unstable"
import type { AgentSnapshot } from "./agent-protocol.ts"
import { executeGit } from "./git-execution.ts"
import type { WorktreePreferences } from "./worktree-preferences.ts"

/** Apply the naming preference once, before the first generated-checkout turn. */
export async function prepareWorktreeBranchPrompt(
  snapshot: AgentSnapshot,
  currentTurnId: string,
  directories: readonly { path: string }[],
  naming: WorktreePreferences["branchNaming"],
  originId: string,
  prompt: ContentBlock[],
): Promise<ContentBlock[]> {
  if (snapshot.session.context !== "worktree" || snapshot.session.inheritedTurnCount
    || snapshot.turns.some(turn => turn.id !== currentTurnId && turn.consumed !== false)) return prompt
  const roots = new Set<string>()
  for (const directory of directories) {
    const result = await executeGit(["-C", directory.path, "rev-parse", "--show-toplevel"])
    roots.add(result.stdout.trimEnd())
  }
  const unnamed: string[] = []
  for (const [index, root] of [...roots].entries()) {
    const branch = await executeGit(["-C", root, "symbolic-ref", "--quiet", "HEAD"], { acceptExit: [1] })
    // A person or provider may already have selected a branch before dispatch.
    if (branch.stdout.trim()) continue
    if (naming === "session") {
      const name = `deskfleet/session-${originId.slice(0, 8)}-${snapshot.session.id}${index ? `-${index + 1}` : ""}`
      await executeGit(["-C", root, "switch", "-c", name])
    } else unnamed.push(root)
  }
  if (!unnamed.length) return prompt
  const instructions = [
    "DeskFleet worktree branch naming preference: semantic prefix.",
    "Before editing files, create a branch from the current HEAD in each generated checkout listed below.",
    "Choose a short branch name from the user's first task, using a semantic prefix such as feat/add-search, fix/login-timeout, or refactor/auth.",
    "Use git switch -c with your chosen name. If the name is already taken, choose a unique suffix; do not replace an existing branch.",
    "Only do this while the checkout is still detached. Keep any branch already selected by the user.",
    `Generated checkouts: ${JSON.stringify(unnamed)}`,
  ].join("\n")
  return [{ type: "text", text: instructions }, ...prompt]
}
