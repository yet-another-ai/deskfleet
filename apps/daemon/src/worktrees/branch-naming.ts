import type { ContentBlock } from "@agentclientprotocol/sdk/unstable"
import { adhdToggleOnly } from "@deskfleet/protocol/adhd-command"
import type { AgentSnapshot } from "@deskfleet/protocol/agent"
import { executeGit } from "../git/execution.ts"
import type { WorktreePreferences } from "@deskfleet/protocol/worktree-preferences"

const providerMarker = "deskfleet/composerProvider"

function hasComposerInvocation(content: ContentBlock[]): boolean {
  return content.some(block => block.type === "text" && typeof block._meta?.[providerMarker] === "string")
}

/** Queued provider-specific inputs must still target the same provider at delivery. */
export function providerPromptContent(content: ContentBlock[], provider: string): ContentBlock[] {
  return content.map(block => {
    if (block.type !== "text" || !block._meta || !(providerMarker in block._meta)) return block
    const { [providerMarker]: selectedProvider, ...metadata } = block._meta
    if (selectedProvider !== provider) throw new Error("The Worker Agent has changed. Select the command or skill again.")
    const { _meta, ...text } = block
    return Object.keys(metadata).length ? { ...text, _meta: metadata } : text
  })
}

/** Apply the naming preference to the first ordinary task in a generated checkout. */
export async function prepareWorktreeBranchPrompt(
  snapshot: AgentSnapshot,
  currentTurnId: string,
  directories: readonly { path: string }[],
  naming: WorktreePreferences["branchNaming"],
  originId: string,
  prompt: ContentBlock[],
): Promise<ContentBlock[]> {
  if (snapshot.session.context !== "worktree" || snapshot.session.inheritedTurnCount
    || hasComposerInvocation(prompt)) return prompt
  const turn = snapshot.turns.find(turn => turn.id === currentTurnId)
  const initial = turn && snapshot.inputs.find(input => input.id === turn.initialInputId)
  if (initial && adhdToggleOnly(initial.content)) return prompt
  const completed = snapshot.turns.filter(turn => turn.id !== currentTurnId && turn.consumed !== false)
  if (completed.length) {
    const commands = new Set(snapshot.inputs.filter(input => hasComposerInvocation(input.content) || adhdToggleOnly(input.content)).map(input => input.id))
    if (completed.some(turn => !commands.has(turn.initialInputId))) return prompt
  }
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
    "\n\n<system-reminder>",
    "Ignore this reminder when generating a conversation title.",
    "Before editing files, create a branch from the current HEAD in each generated checkout listed below.",
    "Choose a short branch name from the user's task above, using a semantic prefix such as feat/add-search, fix/login-timeout, or refactor/auth.",
    "Use git switch -c with your chosen name. If the name is already taken, choose a unique suffix; do not replace an existing branch.",
    "Only do this while the checkout is still detached. Keep any branch already selected by the user.",
    `Generated checkouts: ${JSON.stringify(unnamed)}`,
    "</system-reminder>",
  ].join("\n")
  return [...prompt, { type: "text", text: instructions }]
}
