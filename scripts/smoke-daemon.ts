import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { once } from "node:events"
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const output = join(root, "apps/daemon/dist")
const directory = mkdtempSync(join(tmpdir(), "deskfleet-smoke-"))
const executableName = process.platform === "win32" ? "deskfleet-daemon.exe" : "deskfleet-daemon"
const command = join(directory, executableName)
const environment = { ...process.env }
for (const key of Object.keys(environment)) {
  if (/^(PATH|NODE_PATH|NODE_OPTIONS)$/iu.test(key)) delete environment[key]
}
environment.PATH = ""
environment.DESKFLEET_DAEMON_DIRECTORY = join(directory, "control")

try {
  copyFileSync(join(output, executableName), command)
  chmodSync(command, 0o755)

  const manifest = JSON.parse(readFileSync(join(root, "apps/daemon/package.json"), "utf8")) as {
    version: string
    dependencies: Record<string, string>
  }
  const expectedNative = {
    version: manifest.version,
    os: process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform,
    arch: process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch,
  }
  const info = JSON.parse(execFileSync(command, ["--info"], {
    cwd: directory, env: environment, encoding: "utf8", timeout: 15_000,
  })) as { native: typeof expectedNative; runtime: { node: string; sea: boolean } }
  assert.deepEqual(info.native, expectedNative)
  assert.equal(info.runtime.sea, true)
  assert.equal(info.runtime.node, process.versions.node)

  const adapterVersion = execFileSync(command, ["--codex-acp", "--version"], {
    cwd: directory, env: environment, encoding: "utf8", timeout: 15_000,
  }).trim()
  assert.equal(adapterVersion, `@agentclientprotocol/codex-acp ${manifest.dependencies["@agentclientprotocol/codex-acp"]}`)
  const claudeAdapterVersion = execFileSync(command, ["--claude-agent-acp", "--version"], {
    cwd: directory, env: environment, encoding: "utf8", timeout: 15_000,
  }).trim()
  assert.equal(claudeAdapterVersion, manifest.dependencies["@agentclientprotocol/claude-agent-acp"])

  const child = spawn(command, ["--port", "0"], {
    cwd: directory, env: environment, stdio: ["ignore", "pipe", "pipe"],
  })
  let diagnostics = ""
  child.stderr.setEncoding("utf8").on("data", chunk => { diagnostics += chunk })
  const timeout = AbortSignal.timeout(15_000)
  const closed = once(child, "close")
  const deadline = once(timeout, "abort").then(() => { throw new Error("Daemon smoke test timed out") })
  const lines = createInterface({ input: child.stdout })
  try {
    const ready = await Promise.race([
      once(lines, "line").then(([line]) => JSON.parse(line as string) as { event: string; address: string }),
      closed.then(() => { throw new Error(`Daemon exited before readiness: ${diagnostics}`) }),
      deadline,
    ])
    assert.equal(ready.event, "ready")
    assert.match(ready.address, /^http:\/\/127\.0\.0\.1:\d+$/u)
    const response = await fetch(`${ready.address}/healthz`, { signal: timeout })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { status: "ok", native: expectedNative })
    const status = JSON.parse(execFileSync(command, ["status"], {
      cwd: directory, env: environment, encoding: "utf8", timeout: 15_000,
    })) as { configured: boolean; connected: boolean; revoked: boolean; identity: { originId: string; machineId: string } }
    assert.equal(status.configured, false)
    assert.equal(status.connected, false)
    assert.equal(status.revoked, false)
    assert.ok(status.identity.originId)
    assert.match(status.identity.machineId, /^\d+$/u)
    const prepared = JSON.parse(execFileSync(command, ["prepare-enrollment"], {
      cwd: directory, env: environment, encoding: "utf8", timeout: 15_000,
    })) as typeof status
    assert.deepEqual(prepared.identity, status.identity, "An unregistered machine needs no directory reset")
    child.kill("SIGTERM")
    const [code, signal] = await Promise.race([closed, deadline])
    if (process.platform !== "win32") {
      assert.equal(code, 0, diagnostics)
      assert.equal(signal, null, diagnostics)
    }
  } finally {
    lines.close()
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    await closed.catch(() => {})
  }
  console.log("Standalone SEA: native bridge, bundled ACP adapter, readiness, health, and shutdown passed")
} finally {
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
