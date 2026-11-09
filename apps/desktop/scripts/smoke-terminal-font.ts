import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import type { TerminalFontResult } from "../../../packages/components/scripts/fixtures/terminal-font-renderer.ts"

const root = resolve(import.meta.dirname, "../../..")
const output = resolve(root, "target/terminal-font-smoke")
await mkdir(output, { recursive: true })
const directory = await mkdtemp(join(output, "run-"))
const fixtures = join(import.meta.dirname, "fixtures")
await Promise.all([
  build({ entryPoints: [join(fixtures, "terminal-font-main.ts")], outfile: join(directory, "main.mjs"), bundle: true, platform: "node", format: "esm", external: ["electron"], target: "node24" }),
  build({ entryPoints: [join(root, "packages/components/scripts/fixtures/terminal-font-renderer.ts")], outfile: join(directory, "renderer.js"), bundle: true, platform: "browser", format: "esm", target: "chrome140" }),
])
await writeFile(join(directory, "index.html"), `<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="renderer.css"><style>
body { margin: 0; padding: 20px; background: #17191f; color: #e0e0e0; font: 14px sans-serif; }
h2 { font-size: 14px; margin: 16px 0 8px; }
</style><script type="module" src="renderer.js"></script>`)
const executable = createRequire(import.meta.url)("electron") as string
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(executable, [join(directory, "main.mjs"), `--user-data-dir=${join(directory, "profile")}`], {
  cwd: root, env, windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"],
})
let diagnostics = ""
child.stderr?.setEncoding("utf8").on("data", (data: string) => { diagnostics += data })
const result = await new Promise<TerminalFontResult>((resolveResult, reject) => {
  const timeout = setTimeout(() => { child.kill(); reject(new Error("Terminal font smoke timed out")) }, 30_000)
  const fail = (error: unknown) => { clearTimeout(timeout); reject(error) }
  child.once("error", fail)
  child.once("exit", code => fail(new Error(`Electron exited before returning font results (${code})\n${diagnostics}`)))
  child.on("message", (message: { result?: TerminalFontResult; error?: string }) => {
    if (message.error) fail(new Error(message.error))
    if (message.result) { clearTimeout(timeout); resolveResult(message.result) }
  })
}).finally(() => { if (child.connected) child.send({ close: true }) })
console.log(`Terminal font evidence: ${directory}`)
assert.equal(result.devicePixelRatio, 2, "Exercise Retina-sized glyphs")
for (const sample of result.samples) {
  assert.ok(sample.fonts.length > 0, `${sample.label}: WebGL must rasterize text`)
  assert.deepEqual(sample.fonts, [sample.expected], `${sample.label}: canvas glyph font must match terminal appearance`)
}
console.log("Electron WebGL terminal fonts: default/custom families, normal, bold, italic, and normal after italic passed", result)
