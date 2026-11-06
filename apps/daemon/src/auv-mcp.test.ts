import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { createInterface } from "node:readline"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { AUV_MCP_INSTRUCTIONS } from "./agents/auv-mcp.ts"

const entry = fileURLToPath(new URL("./fixtures/auv-mcp.ts", import.meta.url))

test("AUV MCP bridge hides its subprocess, negotiates discovery, and forwards MCP messages", { timeout: 10_000 }, async t => {
  const child = spawn(process.execPath, [entry], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })
  const exited = once(child, "close")
  const output = createInterface({ input: child.stdout })
  const lines = output[Symbol.asyncIterator]()
  let stderr = ""
  child.stderr.on("data", chunk => { stderr += String(chunk) })
  t.after(async () => {
    child.stdin.end()
    output.close()
    if (child.exitCode === null) child.kill("SIGKILL")
    await exited
  })
  const response = async () => {
    const line = await lines.next()
    assert.equal(line.done, false, stderr || "AUV bridge exited before replying")
    return JSON.parse(line.value as string)
  }
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "server/discover", params: {} }) + "\n")
  assert.deepEqual(await response(), {
    jsonrpc: "2.0", id: 0, error: { code: -32601, message: "Method not found" },
  })
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n")
  assert.deepEqual(await response(), {
    jsonrpc: "2.0", id: 1,
    result: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "auv", version: "0.0.40" },
      instructions: AUV_MCP_INSTRUCTIONS,
    },
  })
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n")
  assert.deepEqual(await response(), {
    jsonrpc: "2.0", id: 2, result: { tools: [{ name: "screenshot" }] },
  })
  const [code] = await exited
  assert.equal(code, 0, stderr)
})
