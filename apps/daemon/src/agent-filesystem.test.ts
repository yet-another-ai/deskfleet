import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import { createAcpFilesystem } from "./agents/filesystem.ts"

const sessionId = "provider-session"
const filesystem = createAcpFilesystem(id => {
  if (id !== sessionId) throw new Error("Unknown provider session")
})

async function directory(context: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "df-acp-files-"))
  context.after(() => rm(path, { recursive: true, force: true }))
  return path
}

test("ACP text reads use one-based ranges and preserve original line endings", async context => {
  const path = join(await directory(context), "text.txt")
  const content = "first\r\n\r\n第三行\nlast"
  await writeFile(path, content)
  assert.deepEqual(await filesystem.readTextFile({ sessionId, path }), { content })
  assert.deepEqual(await filesystem.readTextFile({ sessionId, path, line: 2, limit: 2 }), { content: "\r\n第三行\n" })
  assert.deepEqual(await filesystem.readTextFile({ sessionId, path, line: 4 }), { content: "last" })
  assert.deepEqual(await filesystem.readTextFile({ sessionId, path, limit: 1 }), { content: "first\r\n" })
  assert.deepEqual(await filesystem.readTextFile({ sessionId, path, line: null, limit: null }), { content })
  assert.deepEqual(await filesystem.readTextFile({ sessionId, path, line: 5 }), { content: "" })
  assert.deepEqual(await filesystem.readTextFile({ sessionId, path, limit: 0 }), { content: "" })
  await writeFile(path, "final\n")
  assert.deepEqual(await filesystem.readTextFile({ sessionId, path, limit: 1 }), { content: "final\n" })
})

test("ACP text writes create parents and replace existing file contents", async context => {
  const path = join(await directory(context), "nested", "child", "text.txt")
  assert.deepEqual(await filesystem.writeTextFile({ sessionId, path, content: "你好\r\n" }), {})
  assert.equal(await readFile(path, "utf8"), "你好\r\n")
  await filesystem.writeTextFile({ sessionId, path, content: "short" })
  assert.equal(await readFile(path, "utf8"), "short")
  await filesystem.writeTextFile({ sessionId, path, content: "" })
  assert.equal(await readFile(path, "utf8"), "")
})

test("ACP filesystem callbacks validate session ownership before touching files", async context => {
  const root = await directory(context)
  const path = join(root, "existing.txt")
  await writeFile(path, "original")
  await assert.rejects(filesystem.readTextFile({ sessionId: "unrelated", path }), /Unknown provider session/u)
  await assert.rejects(filesystem.writeTextFile({ sessionId: "unrelated", path, content: "changed" }), /Unknown provider session/u)
  assert.equal(await readFile(path, "utf8"), "original")
  const missing = join(root, "uncreated", "file.txt")
  await assert.rejects(filesystem.writeTextFile({ sessionId: "unrelated", path: missing, content: "changed" }), /Unknown provider session/u)
  await assert.rejects(stat(join(root, "uncreated")), { code: "ENOENT" })
})

test("ACP filesystem callbacks reject relative paths and invalid ranges, and report missing files", async context => {
  const path = join(await directory(context), "missing.txt")
  await assert.rejects(filesystem.readTextFile({ sessionId, path: "relative.txt" }), { code: -32602 })
  await assert.rejects(filesystem.writeTextFile({ sessionId, path: "relative.txt", content: "text" }), { code: -32602 })
  await assert.rejects(filesystem.readTextFile({ sessionId, path, line: 0 }), { code: -32602 })
  await assert.rejects(filesystem.readTextFile({ sessionId, path, limit: -1 }), { code: -32602 })
  await assert.rejects(filesystem.readTextFile({ sessionId, path }), { code: "ENOENT" })
})
