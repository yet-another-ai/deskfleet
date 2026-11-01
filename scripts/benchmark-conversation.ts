import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { cpus, platform, release } from "node:os"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { parseArgs } from "node:util"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"

const root = resolve(import.meta.dirname, "..")
const requireDesktop = createRequire(resolve(root, "apps/desktop/package.json"))
const requireComponents = createRequire(resolve(root, "packages/components/package.json"))
const { values } = parseArgs({ options: {
  turns: { type: "string", default: "0,20,80" }, rounds: { type: "string", default: "3" },
  chunks: { type: "string", default: "120" }, "interval-ms": { type: "string", default: "16" },
  expanded: { type: "boolean", default: false }, scroll: { type: "string", default: "bottom" },
  label: { type: "string", default: "working-tree" }, profile: { type: "boolean", default: false },
  "skip-build": { type: "boolean", default: false }, help: { type: "boolean", default: false },
} })
if (values.help) {
  console.log("Usage: mise exec -- node scripts/benchmark-conversation.ts [--turns 0,20,80] [--rounds 3] [--chunks 120] [--interval-ms 16] [--expanded] [--scroll bottom|history] [--label baseline] [--profile] [--skip-build]\nBuilds a production Vue renderer and runs deterministic multi-turn conversations in the locked Electron runtime. JSON results and optional Chromium CPU profiles go to result/conversation/<label>. --skip-build reuses the previous renderer build. Compare on the same machine; no timing threshold is asserted.")
  process.exit(0)
}
const turns = values.turns.split(",").map(Number)
const rounds = Number(values.rounds), chunks = Number(values.chunks), intervalMs = Number(values["interval-ms"])
assert.ok(turns.length && turns.every(n => Number.isSafeInteger(n) && n >= 0 && n <= 200))
assert.ok(Number.isSafeInteger(rounds) && rounds >= 1 && rounds <= 20)
assert.ok(Number.isSafeInteger(chunks) && chunks >= 10 && chunks <= 2000)
assert.ok(Number.isFinite(intervalMs) && intervalMs >= 1 && intervalMs <= 1000)
assert.ok(values.scroll === "bottom" || values.scroll === "history")
assert.match(values.label, /^[\w-]+$/u)
const output = resolve(root, "result/conversation", values.label)
const buildDir = resolve(root, "result/conversation/build")
await mkdir(output, { recursive: true })
const load = async (name: string, from = requireDesktop) => import(pathToFileURL(from.resolve(name)).href)
const vite = await load("vite")
if (!values["skip-build"]) {
  const [{ default: vue }, { default: i18n }, { default: uno }] = await Promise.all([
    load("@vitejs/plugin-vue"), load("@intlify/unplugin-vue-i18n/vite"), load("unocss/vite"),
  ])
  await vite.build({
    configFile: false, root: resolve(root, "packages/components/benchmarks/conversation"), base: "./", logLevel: "warn",
    plugins: [uno({ configFile: resolve(root, "packages/components/uno.config.ts") }), vue({ features: { vapor: true } }), i18n({ strictMessage: false, runtimeOnly: true })],
    resolve: { alias: {
      "@agentclientprotocol/sdk/unstable": requireComponents.resolve("@agentclientprotocol/sdk/unstable"),
      "@agentclientprotocol/sdk": requireComponents.resolve("@agentclientprotocol/sdk"),
    } },
    build: { outDir: buildDir, emptyOutDir: true, sourcemap: true },
  })
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()
  const sources = ["pnpm-lock.yaml", "packages/components/src/components/session/AgentMarkdown.vue", "packages/components/src/services/mermaid.ts", "packages/components/src/services/mermaid-svg.ts", "packages/components/benchmarks/conversation/fixture.ts", "packages/components/benchmarks/conversation/Harness.vue"]
  await writeFile(resolve(buildDir, "provenance.json"), JSON.stringify({
    commit: git(["rev-parse", "HEAD"]), dirty: Boolean(git(["status", "--porcelain"])),
    diffSha256: createHash("sha256").update(git(["diff", "HEAD"])).digest("hex"),
    sources: Object.fromEntries(await Promise.all(sources.map(async path => [path, createHash("sha256").update(await readFile(resolve(root, path))).digest("hex")]))),
  }, null, 2))
}
const { build } = await import("esbuild")
const electronMain = resolve(root, "result/conversation/runner.cjs")
await build({ entryPoints: [resolve(root, "apps/desktop/scripts/benchmark-conversation.ts")], outfile: electronMain,
  bundle: true, platform: "node", format: "cjs", external: ["electron"],
})
const server = await vite.preview({ configFile: false, root, build: { outDir: buildDir }, preview: { host: "127.0.0.1", port: 0, open: false } })
const address = server.httpServer.address()
assert.ok(address && typeof address === "object")
const url = `http://127.0.0.1:${address.port}`
const metadata = { label: values.label, build: JSON.parse(await readFile(resolve(buildDir, "provenance.json"), "utf8")),
  buildIndexSha256: createHash("sha256").update(await readFile(resolve(buildDir, "index.html"))).digest("hex"),
  platform: platform(), os: release(), cpu: cpus()[0]?.model, cpuCount: cpus().length, node: process.version,
  viewport: { width: 1280, height: 900 }, offscreenFrameRate: 60, rounds, turns, chunks, intervalMs, expanded: values.expanded, scroll: values.scroll,
}
await writeFile(resolve(output, "metadata.json"), JSON.stringify(metadata, null, 2))
try {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  await new Promise<void>((done, reject) => {
    const child = spawn(requireDesktop("electron"), [electronMain, JSON.stringify({ url, output, turns, rounds, chunks, intervalMs, expanded: values.expanded, scroll: values.scroll, profile: values.profile })], { env, windowsHide: true, stdio: "inherit" })
    child.once("error", reject)
    child.once("exit", code => code === 0 ? done() : reject(new Error(`Electron benchmark exited ${code}`)))
  })
  const results: Array<{ turns: number; mountMs: number; finalCatchupMs: number; diagramReopenReadyMs: number | null; frameIntervalMs: { p95: number }; eventToFrameMs: { p95: number }; longTasks: { totalMs: number } }> = JSON.parse(await readFile(resolve(output, "results.json"), "utf8"))
  const median = (numbers: number[]) => {
    const sorted = numbers.sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return Number(((sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2)).toFixed(1))
  }
  for (const count of turns) {
    const runs = results.filter(result => result.turns === count)
    const diagramReopens = runs.flatMap(result => result.diagramReopenReadyMs == null ? [] : [result.diagramReopenReadyMs])
    console.log(JSON.stringify({ label: values.label, turns: count, rounds: runs.length, medianMountMs: median(runs.map(r => r.mountMs)),
      medianFrameP95Ms: median(runs.map(r => r.frameIntervalMs.p95)), medianUpdateToFrameP95Ms: median(runs.map(r => r.eventToFrameMs.p95)),
      medianFinalCatchupMs: median(runs.map(r => r.finalCatchupMs)), medianLongTaskTotalMs: median(runs.map(r => r.longTasks.totalMs)),
      medianDiagramReopenReadyMs: diagramReopens.length ? median(diagramReopens) : null,
    }))
  }
  console.log(`Raw samples and metadata: ${output}`)
} finally {
  await new Promise<void>(done => server.httpServer.close(() => done()))
}
