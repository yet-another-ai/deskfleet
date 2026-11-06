import assert from "node:assert/strict"
import childProcess from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import { basename } from "node:path"
import { createInterface } from "node:readline"
import { runAuvMcp } from "../agents/auv-mcp.ts"

if (process.argv[2] === "serve") {
  // Preloaded before Node resolves `mcp`: use a real executable on Windows too.
  assert.equal(basename(process.argv[1]!), "mcp")
  for await (const line of createInterface({ input: process.stdin })) {
    const message = JSON.parse(line)
    if (message.method === "server/discover") process.exit(9)
    if (message.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {
        protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "auv", version: "0.0.40" },
      } }) + "\n")
    }
    if (message.method === "tools/list") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "screenshot" }] } }) + "\n", () => process.exit(0))
    }
  }
  process.exit(0)
} else {
  const spawn = childProcess.spawn
  childProcess.spawn = ((command, args, options) => {
    assert.equal(command, process.execPath)
    assert.deepEqual(args, ["mcp", "serve"])
    assert.equal(options?.windowsHide, true, "AUV must not open a Windows console")
    return spawn(command, args, options)
  }) as typeof spawn
  syncBuiltinESMExports()
  process.env.NODE_OPTIONS = `--import=${import.meta.url}`
  await runAuvMcp({ DESKFLEET_AUV_PATH: process.execPath })
}
