import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"
import { runInNewContext } from "node:vm"

const require = createRequire(import.meta.url)
const codex = readFileSync(require.resolve("@agentclientprotocol/codex-acp"), "utf8")
const pi = readFileSync(require.resolve("pi-acp"), "utf8")

// These executable-only packages do not export their launchers. Run the actual
// pinned functions and stop at the OS boundary, before any real agent starts.
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

test("Pi RPC launches stay hidden for executables and command shims while preserving session context", async t => {
  const match = pi.match(/^  static async spawn\(params\) \{[\s\S]*?^  \}/m)
  assert.ok(match, "Pinned PiRpcProcess.spawn exists")
  const helpers = ["defaultPiCommand", "getPiCommand", "shouldUseShellForPiCommand"].map(name => publishedFunction(pi, name)).join("\n")
  for (const scenario of [
    { name: "Windows executable", platform: "win32", binary: "C:\\Agent Tools\\pi.exe", expected: "C:\\Agent Tools\\pi.exe", kind: "spawn", session: true },
    { name: "Windows command shim", platform: "win32", binary: "C:\\Agent Tools\\pi.cmd", expected: "C:\\Agent Tools\\pi.cmd", kind: "crossSpawn", session: false },
    { name: "Windows batch shim", platform: "win32", binary: "C:\\Agent Tools\\pi.bat", expected: "C:\\Agent Tools\\pi.bat", kind: "crossSpawn", session: true },
    { name: "Windows default", platform: "win32", binary: undefined, expected: "pi.cmd", kind: "crossSpawn", session: false },
    { name: "POSIX executable", platform: "linux", binary: "/opt/agent tools/pi", expected: "/opt/agent tools/pi", kind: "spawn", session: true },
    { name: "POSIX default", platform: "linux", binary: undefined, expected: "pi", kind: "spawn", session: false },
  ]) {
    await t.test(scenario.name, async () => {
      const captured = captureLaunch()
      const env = { PATH: "provider-path", CUSTOM: "preserved" }
      const start = runInNewContext(`${helpers}\n(${match[0].trimStart().replace("static async spawn", "async function startPi")})`, {
        platform: () => scenario.platform,
        process: { env },
        spawn: captured.spawn,
        crossSpawn: captured.crossSpawn,
      }) as (params: { piCommand?: string; cwd: string; sessionPath?: string }) => Promise<unknown>
      const cwd = "/workspace with spaces"
      const sessionPath = scenario.session ? "/sessions/saved session.jsonl" : undefined
      await assert.rejects(start({ piCommand: scenario.binary, cwd, sessionPath }), error => error === captured.stopped)
      assert.equal(captured.calls.length, 1)
      const call = captured.calls[0]!
      assert.equal(call.kind, scenario.kind)
      assert.equal(call.command, scenario.expected)
      assert.deepEqual(call.args, ["--mode", "rpc", "--no-themes", ...(sessionPath ? ["--session", sessionPath] : [])])
      assert.equal(call.options.windowsHide, true)
      assert.equal(call.options.cwd, cwd)
      assert.equal(call.options.stdio, "pipe")
      assert.equal(call.options.env, env)
    })
  }
})
