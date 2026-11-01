import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { cpus, platform, release } from "node:os"
import { relative, resolve } from "node:path"
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
  trace: { type: "boolean", default: false }, capture: { type: "boolean", default: false },
  "isolated-renderer": { type: "string" }, corpus: { type: "string", default: "prose" }, repeats: { type: "string", default: "1" },
  "markdown-renderer": { type: "string", default: "vapor" },
  "skip-build": { type: "boolean", default: false }, help: { type: "boolean", default: false },
} })
if (values.help) {
  console.log("Usage: mise exec -- node scripts/benchmark-conversation.ts [--turns 0,20,80] [--rounds 3] [--chunks 120] [--interval-ms 16] [--expanded] [--scroll bottom|history] [--markdown-renderer vapor|vdom] [--isolated-renderer upstream|upstream-hook|deskfleet] [--corpus prose|rich] [--repeats 1] [--label baseline] [--profile] [--trace] [--capture] [--skip-build]\nBuilds a production Vue renderer in the locked Electron runtime. JSON results, optional CPU profiles, Perfetto traces and scrollback screenshots go to result/conversation/<label>. --isolated-renderer streams a single Markdown message without conversation history. --markdown-renderer changes only the Markdown component group; the rest remains Vapor. --skip-build reuses the previous build for that mode. Compare on the same machine; no timing threshold is asserted.")
  process.exit(0)
}
const isolatedRenderer = values["isolated-renderer"]
assert.ok(!isolatedRenderer || ["upstream", "upstream-hook", "deskfleet"].includes(isolatedRenderer))
assert.ok(values.corpus === "prose" || values.corpus === "rich")
const repeats = Number(values.repeats)
assert.ok(Number.isSafeInteger(repeats) && repeats >= 1 && repeats <= 100)
const isolated = isolatedRenderer ? { renderer: isolatedRenderer, corpus: values.corpus, repeats } : undefined
const turns = isolated ? [0] : values.turns.split(",").map(Number)
const rounds = Number(values.rounds), chunks = Number(values.chunks), intervalMs = Number(values["interval-ms"])
assert.ok(turns.length && turns.every(n => Number.isSafeInteger(n) && n >= 0 && n <= 200))
assert.ok(Number.isSafeInteger(rounds) && rounds >= 1 && rounds <= 20)
assert.ok(Number.isSafeInteger(chunks) && chunks >= 10 && chunks <= 2000)
assert.ok(Number.isFinite(intervalMs) && intervalMs >= 1 && intervalMs <= 1000)
assert.ok(values.scroll === "bottom" || values.scroll === "history")
const markdownRenderer = values["markdown-renderer"]
assert.ok(markdownRenderer === "vapor" || markdownRenderer === "vdom")
assert.match(values.label, /^[\w-]+$/u)
const output = resolve(root, "result/conversation", values.label)
const buildDir = resolve(root, "result/conversation", `build-${markdownRenderer}`)
await mkdir(output, { recursive: true })
const load = async (name: string, from = requireDesktop) => import(pathToFileURL(from.resolve(name)).href)
const vite = await load("vite")
if (!values["skip-build"]) {
  const [{ default: vue }, { default: i18n }, { default: uno }] = await Promise.all([
    load("@vitejs/plugin-vue"), load("@intlify/unplugin-vue-i18n/vite"), load("unocss/vite"),
  ])
  // Markstream ships VDOM components. Include all custom Markdown leaves so the
  // comparison removes their repeated VDOM/Vapor crossings, not just the wrapper.
  const markdownComponents = /\/components\/session\/(?:AgentMarkdown|MermaidViewer|markdown\/[^/]+)\.vue(?:$|\?)/u
  function scopedVuePlugin(markdown: boolean) {
    const plugin = vue({ features: { vapor: !markdown }, ...(markdown ? { include: markdownComponents } : { exclude: markdownComponents }) })
    // plugin-vue admits every ?vue request regardless of include, and its load
    // hook ignores the file filter. Guard both hooks to keep compilation disjoint.
    for (const name of ["load", "transform"] as const) {
      const hook = plugin[name]
      const handler = hook.handler
      hook.handler = function (this: unknown, ...args: unknown[]) {
        const id = String(args[name === "load" ? 0 : 1])
        if (id !== "\0plugin-vue:export-helper" && markdownComponents.test(id.replaceAll("\\", "/")) !== markdown) return
        return handler.apply(this, args)
      }
    }
    return plugin
  }
  const vuePlugins = markdownRenderer === "vdom"
    ? [scopedVuePlugin(true), scopedVuePlugin(false)]
    : [vue({ features: { vapor: true } })]
  const compiledRenderers: Record<string, "vapor" | "vdom"> = {}
  const compilationAudit = {
    name: "benchmark-renderer-compilation-audit", enforce: "post" as const,
    transform(code: string, id: string) {
      const filename = id.split("?")[0]!.replaceAll("\\", "/")
      if (!filename.endsWith(".vue")) return
      const markdown = markdownComponents.test(filename)
      if (!markdown && !/\/(?:AgentConversation|AgentResponse|Harness)\.vue$/u.test(filename)) return
      // TypeScript SFCs can emit their compiled component in a ?vue&type=script
      // subrequest; the main .vue module then only re-exports it.
      if (!/\bdefine(?:Vapor)?Component\b|__vapor:\s*true/u.test(code)) return
      const mode = /\bdefineVaporComponent\b|__vapor:\s*true/u.test(code) ? "vapor" : "vdom"
      assert.equal(mode, markdown ? markdownRenderer : "vapor", `Unexpected compiler mode for ${filename}`)
      compiledRenderers[relative(root, filename).replaceAll("\\", "/")] = mode
    },
  }
  await vite.build({
    configFile: false, root: resolve(root, "packages/components/benchmarks/conversation"), base: "./", logLevel: "warn",
    plugins: [uno({ configFile: resolve(root, "packages/components/uno.config.ts") }), ...vuePlugins, i18n({ strictMessage: false, runtimeOnly: true }), compilationAudit],
    resolve: { alias: {
      "@agentclientprotocol/sdk/unstable": requireComponents.resolve("@agentclientprotocol/sdk/unstable"),
      "@agentclientprotocol/sdk": requireComponents.resolve("@agentclientprotocol/sdk"),
    } },
    build: { outDir: buildDir, emptyOutDir: true, sourcemap: true },
  })
  assert.equal(compiledRenderers["packages/components/src/components/session/AgentMarkdown.vue"], markdownRenderer)
  assert.equal(compiledRenderers["packages/components/src/components/session/AgentConversation.vue"], "vapor")
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()
  const sources = ["pnpm-lock.yaml", "scripts/benchmark-conversation.ts", "apps/desktop/scripts/benchmark-conversation.ts", "packages/components/src/components/session/AgentConversation.vue", "packages/components/src/components/session/AgentMarkdown.vue", "packages/components/src/services/agent-markdown.ts", "packages/components/src/services/mermaid.ts", "packages/components/src/services/mermaid-svg.ts", "packages/components/benchmarks/conversation/fixture.ts", "packages/components/benchmarks/conversation/Harness.vue", "packages/components/benchmarks/conversation/scrollback.ts", "packages/components/benchmarks/conversation/IsolatedMarkdown.vue", "packages/components/benchmarks/conversation/main.ts"]
  await writeFile(resolve(buildDir, "provenance.json"), JSON.stringify({
    markdownRenderer, compiledRenderers,
    commit: git(["rev-parse", "HEAD"]), dirty: Boolean(git(["status", "--porcelain"])),
    diffSha256: createHash("sha256").update(git(["diff", "HEAD"])).digest("hex"),
    sources: Object.fromEntries(await Promise.all(sources.map(async path => [path, createHash("sha256").update(await readFile(resolve(root, path))).digest("hex")]))),
  }, null, 2))
}
if (values.profile || values.trace) {
  const assets = resolve(buildDir, "assets")
  const maps = resolve(output, "source-maps")
  await mkdir(maps, { recursive: true })
  await Promise.all((await readdir(assets)).filter(name => name.endsWith(".map"))
    .map(name => copyFile(resolve(assets, name), resolve(maps, name))))
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
  // --skip-build only reuses renderer assets; these scripts execute afresh.
  execution: Object.fromEntries(await Promise.all(Object.entries({
    orchestrator: import.meta.filename, runnerSource: resolve(root, "apps/desktop/scripts/benchmark-conversation.ts"), runnerBundle: electronMain,
  }).map(async ([name, path]) => [name, createHash("sha256").update(await readFile(path)).digest("hex")]))),
  platform: platform(), os: release(), cpu: cpus()[0]?.model, cpuCount: cpus().length, node: process.version,
  viewport: { width: 1280, height: 900 }, offscreenFrameRate: 60, rounds, turns, chunks, intervalMs, expanded: values.expanded, scroll: values.scroll, isolated,
  profile: values.profile, trace: values.trace, capture: values.capture,
}
await writeFile(resolve(output, "metadata.json"), JSON.stringify(metadata, null, 2))
try {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  await new Promise<void>((done, reject) => {
    const child = spawn(requireDesktop("electron"), [electronMain, JSON.stringify({ url, output, turns, rounds, chunks, intervalMs, expanded: values.expanded, scroll: values.scroll, profile: values.profile, trace: values.trace, capture: values.capture, isolated })], { env, windowsHide: true, stdio: "inherit" })
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
