import { spawn } from "node:child_process"
import { mkdir, mkdtemp } from "node:fs/promises"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"
import { build } from "esbuild"

const root = resolve(import.meta.dirname, "../../..")
const output = join(root, "target/proxy-smoke")
await mkdir(output, { recursive: true })
const directory = await mkdtemp(join(output, "run-"))
const entry = join(directory, "main.mjs")
await build({
  entryPoints: [join(import.meta.dirname, "fixtures/proxy-main.ts")], outfile: entry,
  bundle: true, platform: "node", format: "esm", external: ["electron"], target: "node24",
})
const executable = createRequire(import.meta.url)("electron") as string
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
// The regression must succeed without the workaround from issue #543.
for (const name of Object.keys(env)) {
  if (/^(https?_proxy|all_proxy|no_proxy|node_use_env_proxy)$/i.test(name)) delete env[name]
}
const child = spawn(executable, [entry, `--user-data-dir=${join(directory, "profile")}`], {
  cwd: root, env, windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"],
})
let diagnostics = ""
child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { diagnostics += chunk })
const result = await new Promise<unknown>((resolveResult, reject) => {
  const timeout = setTimeout(() => { child.kill(); reject(new Error(`Proxy smoke timed out\n${diagnostics}`)) }, 30_000)
  child.once("error", error => { clearTimeout(timeout); reject(error) })
  child.once("exit", code => { clearTimeout(timeout); reject(new Error(`Electron exited before proxy results (${code})\n${diagnostics}`)) })
  child.on("message", (message: { result?: unknown; error?: string }) => {
    clearTimeout(timeout)
    if (message.error) reject(new Error(message.error))
    else resolveResult(message.result)
  })
}).finally(() => { if (child.connected) child.send({ close: true }) })
console.log("Electron proxy sign-in, authenticated HTTP, and WebSocket events passed", result)
console.log(`Proxy evidence: ${directory}`)
