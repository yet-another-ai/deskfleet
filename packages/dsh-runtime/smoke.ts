import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { Readable, Writable } from "node:stream"
import * as acp from "@agentclientprotocol/sdk/unstable"
import { bundledDshRuntime, configureDshRuntime, dshAccountProcess, dshAcpProcess, sourceDshRuntime, type DshRuntime } from "./src/index.ts"

/** Exercise the selected host with no system Node/npm/dsh, credentials, or model request. */
export async function smokeDsh(runtime: DshRuntime): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "deskfleet-dsh-smoke-"))
  const env = Object.fromEntries([...Object.entries({ ...process.env,
    PATH: "", NODE_PATH: "", NODE_OPTIONS: "", HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    DSH_HOME: join(home, ".dsh"), DSH_AGENTS_HOME: join(home, ".agents"),
    DESKFLEET_DSH_CREDENTIALS_PATH: join(home, "registration", ".credentials.yaml"),
    DEEPSEEK_API_KEY: "", DEEPSEEK_BASE_URL: "https://api.deepseek.com",
  }), ...Object.entries(runtime.env ?? {})].map(([key, value]) => [process.platform === "win32" ? key.toUpperCase() : key, value]))
  try {
    configureDshRuntime(runtime)
    const manifest = JSON.parse(await readFile(join(dirname(runtime.entryPoint), "../package.json"), "utf8")) as { version: string }
    const version = execFileSync(runtime.command, [...runtime.args ?? [], runtime.entryPoint, "--version"], {
      env, cwd: home, encoding: "utf8", timeout: 30_000, windowsHide: true,
    }).trim()
    assert.equal(version, manifest.version)
    const probe = dshAccountProcess("status", env)
    assert.deepEqual(JSON.parse(execFileSync(probe.command, probe.args ?? [], {
      env: { ...env, ...probe.env }, cwd: home, encoding: "utf8", timeout: 30_000, windowsHide: true,
    })), { auth: "unauthenticated" })
    smokeNativeHelpers(runtime, env, home)
    await smokeAcp(runtime, env, home)
    console.log(`dsh ${version}: account probe, native helpers, ACP initialization, and newSession passed without system Node/npm/dsh`)
  } finally { await rm(home, { recursive: true, force: true }) }
}

function smokeNativeHelpers(runtime: DshRuntime, env: NodeJS.ProcessEnv, cwd: string): void {
  const output = execFileSync(runtime.command, [...runtime.args ?? [], "-e", `
    const assert = require('node:assert/strict');
    const { createRequire } = require('node:module');
    const { join } = require('node:path');
    const { pathToFileURL } = require('node:url');
    const dshRequire = createRequire(process.argv[1]);
    const subprocessEntry = dshRequire.resolve('@deepseek-ai/dsh-subprocess-local');
    const dependency = createRequire(subprocessEntry);
    (async () => {
      const koffi = dependency('koffi');
      const library = process.platform === 'win32' ? 'kernel32.dll'
        : process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
      const signature = process.platform === 'win32' ? 'uint32_t GetCurrentProcessId()' : 'int getpid()';
      assert.equal(koffi.load(library).func(signature)(), process.pid);
      const shell = process.platform === 'win32'
        ? join(process.env.SYSTEMROOT, 'System32', 'cmd.exe') : '/bin/sh';
      const args = process.platform === 'win32' ? ['/d', '/c', 'echo deskfleet-dsh-native']
        : ['-c', 'printf deskfleet-dsh-native'];
      const { Context } = await import(pathToFileURL(dependency.resolve('@deepseek-ai/cordis')).href);
      const { LocalSubprocessRuntime } = await import(pathToFileURL(subprocessEntry).href);
      const ctx = new Context();
      try {
        const service = new LocalSubprocessRuntime(ctx);
        const child = service.spawn({ argv: [shell, ...args], cwd: process.cwd(),
          stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
          graceMs: 1000, signal: AbortSignal.timeout(15_000) });
        assert.equal((await child.done).exitCode, 0);
        assert.match(child.collected.stdout.readFrom(0).text, /deskfleet-dsh-native/);
        assert.equal(await child.waitForExit(AbortSignal.timeout(3000)), true);
      } finally { await ctx.fiber.dispose(); }
      const terminal = dependency('node-pty').spawn(shell, args, { env: process.env });
      let output = '';
      terminal.onData(data => { output += data; });
      try {
        const { exitCode } = await new Promise(resolve => terminal.onExit(resolve));
        assert.equal(exitCode, 0);
        assert.match(output, /deskfleet-dsh-native/);
      } finally { terminal.destroy(); }
    })().then(() => {
      process.stdout.write('deskfleet-dsh-native-ok');
    }, error => { console.error(error); process.exitCode = 1; });
  `, runtime.entryPoint], { env, cwd, encoding: "utf8", timeout: 30_000, windowsHide: true })
  assert.equal(output, "deskfleet-dsh-native-ok")
}

async function smokeAcp(runtime: DshRuntime, env: NodeJS.ProcessEnv, cwd: string): Promise<void> {
  configureDshRuntime(runtime)
  const launch = dshAcpProcess(env)
  const child = spawn(launch.command, launch.args ?? [], {
    env: { ...env, ...launch.env }, cwd, windowsHide: true, stdio: ["pipe", "pipe", "inherit"],
  })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveExit => {
    child.once("close", (code, signal) => resolveExit({ code, signal }))
  })
  const connection = acp.client({ name: "deskfleet-dsh-smoke" }).connect(acp.ndJsonStream(
    Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  ))
  child.once("error", error => connection.close(error))
  child.once("exit", (code, signal) => connection.close(new Error(`dsh ACP exited (${signal ?? code})`)))
  const deadline = setTimeout(() => connection.close(new Error("dsh ACP smoke timed out")), 30_000)
  try {
    const initialization = await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION, clientInfo: { name: "deskfleet-dsh-smoke", version: "1" }, clientCapabilities: {},
    })
    assert.match(initialization.agentInfo?.name ?? "", /dsh|deepseek/iu)
    assert.equal(initialization.protocolVersion, acp.PROTOCOL_VERSION)
    const session = await connection.agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] })
    assert.ok(session.sessionId)
  } finally {
    clearTimeout(deadline)
    child.stdin.end()
    connection.close()
    const shutdown = setTimeout(() => child.kill("SIGKILL"), 5_000)
    try { assert.deepEqual(await exited, { code: 0, signal: null }, "dsh must exit cleanly after ACP disconnect") }
    finally { clearTimeout(shutdown) }
  }
}

if (import.meta.main) await smokeDsh(process.argv[2] ? bundledDshRuntime(resolve(process.argv[2])) : sourceDshRuntime())
