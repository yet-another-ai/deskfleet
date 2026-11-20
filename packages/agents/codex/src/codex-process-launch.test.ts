import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import { runInNewContext } from "node:vm"

const codex = readFileSync(createRequire(import.meta.url).resolve("@agentclientprotocol/codex-acp"), "utf8")

function publishedFunction(source: string, name: string): string {
  const match = source.match(new RegExp(`^function ${name}\\([\\s\\S]*?^\\}`, "m"))
  assert.ok(match, `Pinned adapter function ${name} exists`)
  return match[0]
}

function captureLaunch() {
  const stopped = new Error("Process launch captured")
  const calls: { kind: string; command: string; args: string[]; options: Record<string, unknown> }[] = []
  const spawn = (kind: string) => (command: string, args: string[], options: Record<string, unknown>): never => {
    calls.push({ kind, command, args: Array.from(args), options })
    throw stopped
  }
  return { stopped, calls, spawn: spawn("spawn"), crossSpawn: spawn("crossSpawn") }
}

test("Codex app-server launches stay hidden while preserving executable selection, arguments, and environment", async t => {
  for (const scenario of [
    { name: "Windows executable", platform: "win32", binary: "C:\\Agent Tools\\codex.exe", kind: "crossSpawn", custom: true },
    { name: "Windows command shim", platform: "win32", binary: "C:\\Agent Tools\\codex.cmd", kind: "crossSpawn", custom: false },
    { name: "POSIX executable", platform: "linux", binary: "/opt/agent tools/codex", kind: "spawn", custom: true },
    { name: "bundled fallback", platform: "win32", binary: undefined, kind: "spawn", custom: false },
  ]) {
    await t.test(scenario.name, () => {
      const captured = captureLaunch()
      const inherited = { PATH: "host-path", INHERITED: "yes" }
      const configured = { PATH: "configured-path", CUSTOM: "yes" }
      const args = ["app-server", "--config", "value with spaces"]
      const start = runInNewContext(`(${publishedFunction(codex, "startCodexConnection")})`, {
        process: { platform: scenario.platform, execPath: "host.exe", env: inherited },
        spawn: captured.spawn,
        import_cross_spawn: { default: captured.crossSpawn },
        require2: { resolve(name: string) {
          assert.equal(name, "@openai/codex/bin/codex.js")
          return "/bundled codex/codex.js"
        } },
      }) as (binary?: string, env?: Record<string, string>, args?: string[]) => unknown
      assert.throws(() => scenario.custom ? start(scenario.binary, configured, args) : start(scenario.binary), error => error === captured.stopped)
      assert.equal(captured.calls.length, 1)
      const call = captured.calls[0]!
      assert.equal(call.kind, scenario.kind)
      assert.equal(call.command, scenario.binary ?? "host.exe")
      assert.deepEqual(call.args, scenario.binary ? (scenario.custom ? args : ["app-server"]) : ["/bundled codex/codex.js", "app-server"])
      assert.equal(call.options.windowsHide, true)
      assert.equal(call.options.env, scenario.custom ? configured : inherited)
    })
  }
})
