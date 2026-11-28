import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { createSuperEvidence, superHistoryExcerpt } from "./evidence.ts"
import type { AgentEvent } from "@deskfleet/protocol/agent"

test("evidence reads authenticated workspace bindings, produces bounded line references and rejects traversal", async t => {
  const base = await mkdtemp(join(tmpdir(), "deskfleet-super-evidence-"))
  t.after(() => rm(base, { recursive: true, force: true }))
  const roots = [join(base, "A"), join(base, "B")]
  for (const dir of roots) await mkdir(dir)
  await writeFile(join(roots[0]!, "app.ts"), "export const local = 1\n")
  await writeFile(join(roots[1]!, "app.ts"), "export const peer = 2\n// find-me\n")
  await writeFile(join(roots[1]!, "binary.bin"), Buffer.from([0, 3, 4]))
  const read = createSuperEvidence({ listRoots: async id => id === "A" ? [roots[0]!] : id === "B" ? [roots[1]!] : [] })
  const file = { kind: "read" as const, workspaceId: "B", rootIndex: 0, path: "app.ts" }
  const answer = JSON.parse(await read({ ...file, line: 2 }))
  assert.deepEqual([answer.workspaceId, answer.firstLine, answer.text], ["B", 2, "// find-me\n"])
  assert.match(await read({ kind: "search", workspaceId: "B", rootIndex: 0, query: "find-me" }), /app\.ts:2/u)
  await assert.rejects(read({ ...file, path: "../A/app.ts" }), /relative path/u)
  await assert.rejects(read({ ...file, path: roots[0] }), /relative path/u)
  await assert.rejects(read({ ...file, rootIndex: 2 }), /Unknown workspace/u)
  await assert.rejects(read({ ...file, workspaceId: "missing" }), /Unknown workspace/u)
  await assert.rejects(read({ ...file, path: "binary.bin" }), /Binary/u)
  if (process.platform === "win32") return
  await symlink(roots[0]!, join(roots[1]!, "alias"), "dir")
  await assert.rejects(read({ ...file, path: "alias/app.ts" }), /outside this workspace/u)
})
test("historical evidence excludes tool arguments, private reasoning and permission details", () => {
  const ev = (seq: string, kind: string, payload: unknown) => ({ seq, kind, payload } as AgentEvent)
  const rows = [
    ev("1", "input", { content: [{ type: "text", text: "question" }] }),
    ev("2", "acp", { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "res" } } }),
    ev("3", "acp", { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ult" } } }),
    ev("4", "acp", { update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "private" } } }),
    ev("5", "command", { params: "secret" }),
    ev("6", "acp", { _meta: { deskfleet: { subagent: true } }, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "private" } } }),
  ]
  const result = superHistoryExcerpt(rows)
  assert.match(result, /result/u); assert.match(result, /question/u); assert.doesNotMatch(result, /secret|private/u)
})

test("history pagination preserves repeated user messages with distinct IDs and resumable sequence boundaries", () => {
  const inputs = Array.from({ length: 30 }, (_, index) => ({
    seq: String(index + 1), kind: "input", payload: { id: `input-${index}`, content: [{ type: "text", text: "x".repeat(2000) }] },
  } as AgentEvent))
  const page = JSON.parse(superHistoryExcerpt(inputs))
  assert.ok(page.truncated)
  assert.ok(page.messages.length > 1)
  assert.equal(page.nextAfterSeq, page.messages.at(-1).endSeq)
  const next = JSON.parse(superHistoryExcerpt(inputs.filter(event => Number(event.seq) > Number(page.nextAfterSeq))))
  assert.equal(Number(next.messages[0].seq), Number(page.nextAfterSeq) + 1)
})
