import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { AUV_MCP_ARGUMENT } from "./adapter-host.ts"
import { AUV_MCP_INSTRUCTIONS } from "./auv-mcp.ts"

const entry = fileURLToPath(new URL("../main.ts", import.meta.url))

test("AUV MCP bridge negotiates server/discover, attaches computer-use instructions, and forwards initialize", async t => {
  const directory = await mkdtemp(join(tmpdir(), "deskfleet-auv-mcp-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const fakeAuv = join(directory, process.platform === "win32" ? "auv.cmd" : "auv")
  const server = join(directory, "fake-auv.mjs")
  await writeFile(server, `
    import { createInterface } from "node:readline"
    if (process.argv[2] !== "mcp" || process.argv[3] !== "serve") process.exit(2)
    for await (const line of createInterface({ input: process.stdin })) {
      const message = JSON.parse(line)
      if (message.method === "server/discover") process.exit(9)
      if (message.method === "initialize") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "auv", version: "0.0.40" } } }) + "\\n")
      }
      if (message.method === "tools/list") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "screenshot" }] } }) + "\\n")
        process.exit(0)
      }
    }
  `)
  await writeFile(fakeAuv, process.platform === "win32"
    ? `@"${process.execPath}" "${server}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${server}" "$@"\n`)
  if (process.platform !== "win32") await chmod(fakeAuv, 0o755)
  const child = spawn(process.execPath, [entry, AUV_MCP_ARGUMENT], {
    env: { ...process.env, DESKFLEET_AUV_PATH: fakeAuv },
    stdio: ["pipe", "pipe", "pipe"],
  })
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "server/discover", params: {} }) + "\n")
  assert.deepEqual(JSON.parse((await lines.next()).value as string), {
    jsonrpc: "2.0", id: 0, error: { code: -32601, message: "Method not found" },
  })
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n")
  assert.deepEqual(JSON.parse((await lines.next()).value as string), {
    jsonrpc: "2.0", id: 1,
    result: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "auv", version: "0.0.40" },
      instructions: AUV_MCP_INSTRUCTIONS,
    },
  })
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n")
  assert.deepEqual(JSON.parse((await lines.next()).value as string), {
    jsonrpc: "2.0", id: 2, result: { tools: [{ name: "screenshot" }] },
  })
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", resolve)
  })
  assert.equal(code, 0)
})
