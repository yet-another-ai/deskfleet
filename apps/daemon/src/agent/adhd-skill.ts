/*!
 * i-have-adhd — Copyright (c) 2026 Ayoub Ghriss. MIT License.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { readFileSync } from "node:fs"
import { adhdCommand, adhdReplyMarker } from "@deskfleet/protocol/adhd-command"
import type { AgentInput, AgentSnapshot } from "@deskfleet/protocol/agent"

// Desktop and standalone daemon bundles embed the same APM-pinned skill file used by source runs.
declare const __DESKFLEET_ADHD_SKILL__: string
let rules: string | undefined
export function adhdReplyInstructions(): string {
  if (!rules) {
    const source = typeof __DESKFLEET_ADHD_SKILL__ === "string" ? __DESKFLEET_ADHD_SKILL__
      : readFileSync(new URL("../../../../.agents/skills/i-have-adhd/SKILL.md", import.meta.url), "utf8")
    const start = source.indexOf("## Rules\n")
    if (start < 0) throw new Error("Missing reply rules in the bundled i-have-adhd skill")
    rules = "DeskFleet reply style for this response only. Apply the following rules to user-visible prose in the user's language. Preserve the task, required output format and permissions. DeskFleet manages the mode across turns.\n\n" + source.slice(start).trim()
  }
  return rules
}

function workerStyleCommand(content: AgentInput["content"]) {
  const first = content.find(block => block.type === "text")
  if (first && !first._meta?.[adhdReplyMarker] && !first._meta?.["deskfleet/composerProvider"]) return adhdCommand(first.text)
}

/** Use actual turn order. Pending, withdrawn and failed commands cannot change the style. */
function previousWorkerStyle(snapshot: Pick<AgentSnapshot, "inputs" | "turns">): boolean {
  const inputs = new Map(snapshot.inputs.map(input => [input.id, input]))
  for (let i = snapshot.turns.length - 1; i >= 0; i--) {
    const input = inputs.get(snapshot.turns[i]!.initialInputId)
    if (input?.state !== "delivered" && input?.state !== "dispatching") continue
    const command = workerStyleCommand(input.content)
    if (command) return command.enabled
  }
  return false
}

export function workerReplyPrompt(content: AgentInput["content"], snapshot: Pick<AgentSnapshot, "inputs" | "turns">): AgentInput["content"] {
  const first = content.find(block => block.type === "text")
  // Expand a front-desk selection only at the ACP boundary, after the visible input was recorded.
  if (first?._meta?.[adhdReplyMarker] === true) {
    const { _meta, ...plain } = first
    const { [adhdReplyMarker]: _style, ...rest } = _meta
    const text = Object.keys(rest).length ? { ...plain, _meta: rest } : plain
    return [...content.map(block => block === first ? text : block), { type: "text", text: adhdReplyInstructions() }]
  }
  // Provider-bound commands need their exact native spelling and payload.
  if (first?._meta?.["deskfleet/composerProvider"]) return content
  const command = first && adhdCommand(first.text)
  if (!command && (/^\s*\/\S+/u.test(first?.text ?? "") || !previousWorkerStyle(snapshot))) return content
  const active = command?.enabled ?? true
  const prompt = command ? content.flatMap(block => {
    if (block !== first) return [block]
    if (command.task && block.type === "text") return [{ ...block, text: command.task }]
    return []
  }) : content
  const instruction = active ? adhdReplyInstructions() : "DeskFleet has turned off ADHD mode. Confirm in one line in the user's language and use the default reply style."
  const receipt = command?.enabled && !prompt.length ? "\n\nBriefly confirm that ADHD mode is on for this conversation." : ""
  return [...prompt, { type: "text", text: instruction + receipt }]
}
