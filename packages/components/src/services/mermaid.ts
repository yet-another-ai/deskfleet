import { instantiateMermaidSvg } from "./mermaid-svg.ts"

type MermaidModule = typeof import("mermaid").default
interface DiagramTemplate { svg: string; documentUrl: string }

let mermaidPromise: Promise<MermaidModule> | undefined
let renderSequence = 0
let renderQueue: Promise<void> = Promise.resolve()
const pending = new Map<string, Promise<DiagramTemplate>>()
const cache = new Map<string, DiagramTemplate & { bytes: number }>()
const MAX_CACHE_ENTRIES = 64
const MAX_CACHE_BYTES = 4 * 1024 * 1024
let cacheBytes = 0

function loadMermaid(): Promise<MermaidModule> {
  mermaidPromise ??= import("mermaid").then(module => module.default)
  return mermaidPromise
}

function retain(key: string, template: DiagramTemplate): void {
  const bytes = (key.length + template.svg.length + template.documentUrl.length) * 2
  if (bytes > MAX_CACHE_BYTES) return
  cache.set(key, { ...template, bytes })
  cacheBytes += bytes
  while (cache.size > MAX_CACHE_ENTRIES || cacheBytes > MAX_CACHE_BYTES) {
    const oldest = cache.keys().next().value!
    cacheBytes -= cache.get(oldest)!.bytes
    cache.delete(oldest)
  }
}

function template(code: string, dark: boolean): Promise<DiagramTemplate> {
  const key = `${dark ? "dark" : "light"}\0${code}`
  const cached = cache.get(key)
  if (cached) {
    cache.delete(key)
    cache.set(key, cached)
    return Promise.resolve(cached)
  }
  const active = pending.get(key)
  if (active) return active
  // initialize mutates Mermaid's global configuration. Its internal render queue
  // does not prevent the next caller's initialize from changing an active theme.
  const rendering = renderQueue.then(async () => {
    const mermaid = await loadMermaid()
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: dark ? "dark" : "default",
      suppressErrorRendering: true,
    })
    const documentUrl = document.URL
    const { svg } = await mermaid.render(`deskfleet-mermaid-source-${++renderSequence}`, code)
    const rendered = { svg, documentUrl }
    retain(key, rendered)
    return rendered
  })
  const result = rendering.finally(() => { pending.delete(key) })
  pending.set(key, result)
  // A failed/incomplete streamed diagram must not block the queue or poison retries.
  renderQueue = result.then(() => {}, () => {})
  return result
}

export async function renderMermaidDiagram(code: string, dark: boolean): Promise<string> {
  const rendered = await template(code, dark)
  return instantiateMermaidSvg(rendered.svg, `deskfleet-mermaid-${++renderSequence}`, rendered.documentUrl)
}
