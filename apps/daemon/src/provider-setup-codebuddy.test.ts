import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { setImmediate as nextTurn } from "node:timers/promises"
import type { AgentProviderInput } from "./provider-protocol.ts"
import { probeProvider, type ProbeDependencies } from "./provider-setup.ts"

const input: AgentProviderInput = { template: "codebuddy", name: "CodeBuddy", inheritShellEnvironment: false, env: {} }
const dependencies: ProbeDependencies = {
  platform: "linux", arch: "x64", env: { PATH: "/tools" }, home: "/home/fixture", cwd: "/working",
  executable: async path => path === "/tools/codebuddy" || path === "/bin/bash",
}

test("CodeBuddy allows slow version and help commands to finish within one detection budget", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const calls: { args: string[]; timeoutMs?: number }[] = []
  const probing = probeProvider(input, {
    ...dependencies,
    run: async (_command, args, _env, _cwd, _signal, timeoutMs) => {
      calls.push({ args, timeoutMs })
      await new Promise(resolve => setTimeout(resolve, 6_000))
      return { stdout: args[0] === "--version" ? "2.184.0" : "Usage: codebuddy|cbc [options] [command] [prompt]", stderr: "", code: 0 }
    },
  }).catch(error => ({ error }))
  await nextTurn()
  t.mock.timers.tick(6_000)
  await nextTurn()
  t.mock.timers.tick(6_000)
  assert.deepEqual(await probing, {
    status: "found", binaryPath: "/tools/codebuddy", version: "2.184.0", auth: "unknown", installable: true, loginAvailable: true,
  })
  assert.deepEqual(calls.map(call => call.args), [["--version"], ["--help"]])
  assert.ok(calls.every(call => (call.timeoutMs ?? 3_000) > 6_000), "Each metadata command must have time to complete")
})

for (const [name, timeoutMs, deadline] of [["default", undefined, 30_000], ["explicit", 25, 25]] as const) {
  test(`CodeBuddy ${name} detection deadline aborts pending metadata work`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] })
    let signal: AbortSignal | undefined
    const rejected = assert.rejects(probeProvider(input, {
      ...dependencies, timeoutMs,
      run: (_command, _args, _env, _cwd, value) => { signal = value; return new Promise(() => {}) },
    }), /Provider detection timed out/u)
    await nextTurn()
    assert.ok(signal)
    t.mock.timers.tick(deadline - 1)
    assert.equal(signal.aborted, false)
    t.mock.timers.tick(1)
    await rejected
    assert.equal(signal.aborted, true)
  })
}

// The fake-timer test exercises slow metadata. Use immediate responses in the real launcher tests.
for (const extension of ["ps1", "cmd"]) {
  test(`Windows discovers CodeBuddy through a .${extension} launcher`, {
    skip: process.platform !== "win32", timeout: 20_000,
  }, async t => {
    const directory = await mkdtemp(join(tmpdir(), "df-codebuddy launcher-"))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const npmDirectory = join(directory, "npm launchers")
    await mkdir(npmDirectory)
    const script = join(directory, "codebuddy-fixture.ts")
    await writeFile(script, `
if (process.argv[2] === "--version") console.log("2.184.0")
else if (process.argv[2] === "--help") console.log("Usage: codebuddy|cbc [options] [command] [prompt]")
else throw new Error("Only read-only metadata commands are allowed")
`)
    const binary = join(npmDirectory, `codebuddy.${extension}`)
    await writeFile(binary, extension === "ps1"
      ? "& $env:DESKFLEET_TEST_NODE $env:DESKFLEET_TEST_SCRIPT @args; exit $LASTEXITCODE\n"
      : '@"%DESKFLEET_TEST_NODE%" "%DESKFLEET_TEST_SCRIPT%" %*\r\n')
    const found = await probeProvider(input, {
      home: directory, cwd: directory,
      env: { ...process.env, PATH: npmDirectory, DESKFLEET_TEST_NODE: process.execPath, DESKFLEET_TEST_SCRIPT: script },
    })
    assert.equal(found.status, "found")
    assert.equal(found.binaryPath, binary)
    assert.equal(found.version, "2.184.0")
    assert.equal(found.auth, "unknown")
  })
}
