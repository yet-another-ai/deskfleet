import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { configureDshRuntime, dshRuntimeProcess } from "../apps/daemon/src/agents/dsh-runtime.ts"
import { deepseekHarnessProvider } from "../apps/daemon/src/agents/deepseek-harness.ts"

/** No system Node/npm/dsh, credentials, or model request is needed for this handshake. */
export async function smokeDsh(directory: string): Promise<void> {
  configureDshRuntime(directory)
  const home = await mkdtemp(join(tmpdir(), "deskfleet-dsh-smoke-"))
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: "", NODE_PATH: "", NODE_OPTIONS: "", HOME: home, USERPROFILE: home,
    DSH_HOME: join(home, ".dsh"), DSH_AGENTS_HOME: join(home, ".agents"), DEEPSEEK_API_KEY: "", DEEPSEEK_BASE_URL: "https://api.deepseek.com" }
  try {
    const manifest = JSON.parse(await readFile(join(directory, "node_modules/@deepseek-ai/dsh/package.json"), "utf8")) as { version: string }
    const version = dshRuntimeProcess(["--version"])
    assert.equal(execFileSync(version.command, version.args ?? [], { env, cwd: home, encoding: "utf8", timeout: 30_000 }).trim(), manifest.version)
    // Exercise the redistributed native addon and executable spawn-helper, not just JS loading.
    const terminal = execFileSync(version.command, ["-e", `
      const pty = require('node-pty');
      const shell = process.platform === 'win32'
        ? require('node:path').join(process.env.SystemRoot || process.env.SYSTEMROOT, 'System32', 'cmd.exe') : '/bin/sh';
      const args = process.platform === 'win32' ? ['/d', '/c', 'echo deskfleet-dsh-pty'] : ['-c', 'printf deskfleet-dsh-pty'];
      const child = pty.spawn(shell, args, { env: process.env });
      let output = '';
      child.onData(data => { output += data });
      child.onExit(({exitCode}) => { process.stdout.write(output); process.exitCode = exitCode });
    `], { env, cwd: directory, encoding: "utf8", timeout: 15_000 })
    assert.match(terminal, /deskfleet-dsh-pty/u)
    const connection = await deepseekHarnessProvider.connect({ name: "DeepSeek Harness",
      env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)) }, {
      onUpdate() {}, signal: AbortSignal.timeout(30_000),
    })
    try {
      assert.match(connection.initialization.agentInfo?.name ?? "", /dsh|deepseek/iu)
      assert.equal(connection.initialization.protocolVersion, 1)
    } finally { await connection.close() }
    console.log(`Bundled dsh ${manifest.version}: version, native PTY, and ACP handshake passed without system Node/npm/dsh`)
  } finally { await rm(home, { recursive: true, force: true }) }
}

if (import.meta.main) await smokeDsh(resolve(process.argv[2] ?? "packages/dsh-runtime/dist"))
