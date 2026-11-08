import assert from "node:assert/strict"
import test from "node:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"
import { CursorNotifications } from "./agents/cursor-notifications.ts"

test("Cursor todos merge by id, replace the full list, and preserve cancelled semantics", () => {
  const cursor = new CursorNotifications()
  const update = (todos: unknown[], merge: boolean) => cursor.update("cursor/update_todos", { toolCallId: "todo-tool", todos, merge }, "session")
  update([{ id: "a", content: "First", status: "pending" }, { id: "b", content: "Second", status: "pending" }], false)
  const merged = update([{ id: "a", content: "First revised", status: "cancelled" }], true)!
  assert.equal(merged.update.sessionUpdate, "plan_update")
  if (merged.update.sessionUpdate !== "plan_update" || merged.update.plan.type !== "items") assert.fail()
  assert.deepEqual(merged.update.plan.entries.map(entry => [entry.content, entry._meta?.cursor]), [
    ["First revised", { id: "a", status: "cancelled" }], ["Second", { id: "b", status: "pending" }],
  ])
  const replaced = update([], false)!
  if (replaced.update.sessionUpdate !== "plan_update" || replaced.update.plan.type !== "items") assert.fail()
  assert.deepEqual(replaced.update.plan.entries, [])
  assert.equal(update([{ id: "invalid", content: "Invalid", status: "bogus" }], true), undefined)
})

test("Cursor task and generated-image notifications retain their tool IDs and resources", () => {
  const cursor = new CursorNotifications()
  const task = { toolCallId: "task-id", description: "Explore", prompt: "Find the entry point", subagentType: "explore", agentId: "cursor-agent", durationMs: 42 }
  const taskUpdate = cursor.update("cursor/task", task, "parent")!.update
  assert.equal(taskUpdate.sessionUpdate, "tool_call")
  if (taskUpdate.sessionUpdate !== "tool_call") assert.fail()
  assert.equal(taskUpdate.toolCallId, "task-id")
  assert.deepEqual(taskUpdate.rawInput, task)
  const image = cursor.update("cursor/generate_image", { toolCallId: "image-id", description: "A diagram", filePath: "diagram.png" }, "parent", tmpdir())!.update
  if (image.sessionUpdate !== "tool_call") assert.fail()
  assert.deepEqual(image.content, [{ type: "content", content: { type: "resource_link",
    uri: pathToFileURL(join(tmpdir(), "diagram.png")).href, name: "diagram.png", description: "A diagram",
  } }])
})
