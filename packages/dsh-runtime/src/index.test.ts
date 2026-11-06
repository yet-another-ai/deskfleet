import assert from "node:assert/strict"
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { pathToFileURL } from "node:url"
import { bundledDshRuntime, configureDshRuntime, dshAccountProcess, dshAcpProcess, dshRuntimeProcess, electronDshHost, sourceDshRuntime } from "./index.ts"

test("source runtime resolves dsh from its owning package, anchored at the embedding application", async () => {
  // Module resolution follows symlinks, including macOS's /var -> /private/var.
  const directory = await realpath(await mkdtemp(join(tmpdir(), "deskfleet-dsh-source-")))
  try {
    const runtime = join(directory, "node_modules", "@deskfleet", "dsh-runtime")
    const entryPoint = join(runtime, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js")
    await mkdir(join(runtime, "node_modules", "@deepseek-ai", "dsh", "lib"), { recursive: true })
    await writeFile(join(runtime, "package.json"), JSON.stringify({ name: "@deskfleet/dsh-runtime", exports: { "./package.json": "./package.json" } }))
    await writeFile(entryPoint, "")
    const anchor = pathToFileURL(join(directory, "package.json"))
    const helperEntryPoint = join(runtime, "src", "helper.ts")
    assert.deepEqual(sourceDshRuntime(anchor), { command: process.execPath, entryPoint, helperEntryPoint })
    const host = electronDshHost(join(directory, "electron"))
    assert.deepEqual(sourceDshRuntime(anchor, host), { ...host, entryPoint, helperEntryPoint })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("standalone runtime uses its relocated private Node and package tree", () => {
  const directory = join(tmpdir(), "relocated deskfleet", "dsh")
  assert.deepEqual(bundledDshRuntime(directory), {
    command: join(directory, "bin", process.platform === "win32" ? "node.exe" : "node"),
    entryPoint: join(directory, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
    helperEntryPoint: join(directory, "helper.js"),
  })
})

test("Electron supplies the host without changing the packaged dependency entry", () => {
  const directory = join(tmpdir(), "DeskFleet.app", "Contents", "Resources", "dsh")
  const executable = join(tmpdir(), "DeskFleet.app", "Contents", "MacOS", "DeskFleet")
  assert.deepEqual(bundledDshRuntime(directory, electronDshHost(executable)), {
    command: executable,
    args: ["--expose-internals"],
    env: { ELECTRON_RUN_AS_NODE: "1" },
    entryPoint: join(directory, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
    helperEntryPoint: join(directory, "helper.js"),
  })
})

test("launch preserves provider arguments and credentials while enforcing the selected host mode", () => {
  const runtime = bundledDshRuntime(join(tmpdir(), "dsh"), electronDshHost("deskfleet-electron"))
  configureDshRuntime(runtime)
  const env = { ELECTRON_RUN_AS_NODE: "0", ...(process.platform === "win32" ? { electron_run_as_node: "0" } : {}), DEEPSEEK_API_KEY: "provider-key" }
  assert.deepEqual(dshRuntimeProcess(["--profile", "acp"], env), {
    command: "deskfleet-electron",
    args: ["--expose-internals", runtime.entryPoint, "--profile", "acp"],
    env: { ELECTRON_RUN_AS_NODE: "1", DEEPSEEK_API_KEY: "provider-key" },
  })
  assert.equal(env.ELECTRON_RUN_AS_NODE, "0")
  assert.deepEqual(runtime.args, ["--expose-internals"])
  for (const action of ["login", "status", "acp"] as const) {
    const process = action === "acp" ? dshAcpProcess(env) : dshAccountProcess(action, env)
    assert.deepEqual(process, {
      command: runtime.command,
      args: ["--expose-internals", runtime.helperEntryPoint, action, runtime.entryPoint],
      env: { ELECTRON_RUN_AS_NODE: "1", DEEPSEEK_API_KEY: "provider-key" },
    })
  }
})
