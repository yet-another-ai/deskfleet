import { beforeEach, expect, test, vi } from "vitest"

const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }))
vi.mock("mermaid", () => ({ default: mermaid }))

beforeEach(() => {
  vi.resetModules()
  mermaid.initialize.mockReset()
  mermaid.render.mockReset().mockImplementation(async (id: string) => ({ svg: `<svg xmlns="http://www.w3.org/2000/svg" id="${id}"><path id="line" /></svg>` }))
})

test("identical concurrent and repeated diagrams render once but have independent instance IDs", async () => {
  const { renderMermaidDiagram } = await import("./mermaid.ts")
  const [first, second] = await Promise.all([renderMermaidDiagram("graph TD; A-->B", false), renderMermaidDiagram("graph TD; A-->B", false)])
  const third = await renderMermaidDiagram("graph TD; A-->B", false)
  expect(mermaid.render).toHaveBeenCalledTimes(1)
  const ids = [first, second, third].flatMap(svg => [...svg.matchAll(/\bid="([^"]+)"/gu)].map(match => match[1]))
  expect(ids).toHaveLength(6)
  expect(new Set(ids).size).toBe(ids.length)
})

test("theme changes use distinct cache entries and initialize only when the prior render has finished", async () => {
  const { renderMermaidDiagram } = await import("./mermaid.ts")
  let finish!: () => void
  mermaid.render.mockImplementationOnce((id: string) => new Promise(resolve => { finish = () => resolve({ svg: `<svg id="${id}" />` }) }))
  const light = renderMermaidDiagram("same graph", false)
  const dark = renderMermaidDiagram("same graph", true)
  await vi.waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1))
  expect(mermaid.initialize).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ theme: "default" }))
  finish()
  await Promise.all([light, dark])
  expect(mermaid.initialize.mock.calls.map(([config]) => config.theme)).toEqual(["default", "dark"])
  await renderMermaidDiagram("same graph", false)
  await renderMermaidDiagram("same graph", true)
  expect(mermaid.render).toHaveBeenCalledTimes(2)
})

test("a failed render is retried and does not block later diagrams", async () => {
  const { renderMermaidDiagram } = await import("./mermaid.ts")
  mermaid.render.mockRejectedValueOnce(new Error("incomplete diagram"))
  await expect(renderMermaidDiagram("partial", false)).rejects.toThrow("incomplete diagram")
  await renderMermaidDiagram("another", false)
  await renderMermaidDiagram("partial", false)
  expect(mermaid.render).toHaveBeenCalledTimes(3)
})

test("cached absolute marker references follow their SVG after route navigation", async () => {
  const { renderMermaidDiagram } = await import("./mermaid.ts")
  const originalUrl = location.href
  try {
    history.replaceState(null, "", "/original-session")
    mermaid.render.mockImplementationOnce(async (id: string) => ({ svg: `<svg id="${id}"><marker id="arrow"/><path marker-end="url('${document.URL}#arrow')"/></svg>` }))
    await renderMermaidDiagram("absolute markers", false)
    history.replaceState(null, "", "/another-session")
    const copy = new DOMParser().parseFromString(await renderMermaidDiagram("absolute markers", false), "image/svg+xml")
    expect(mermaid.render).toHaveBeenCalledTimes(1)
    expect(copy.querySelector("path")!.getAttribute("marker-end")).toBe(`url("#${copy.querySelector("marker")!.id}")`)
  } finally { history.replaceState(null, "", originalUrl) }
})

test("recently used diagrams survive LRU eviction while the oldest diagram is rerendered", async () => {
  const { renderMermaidDiagram } = await import("./mermaid.ts")
  for (let index = 0; index < 64; index++) await renderMermaidDiagram(`graph ${index}`, false)
  await renderMermaidDiagram("graph 0", false)
  await renderMermaidDiagram("graph 64", false)
  await renderMermaidDiagram("graph 0", false)
  expect(mermaid.render).toHaveBeenCalledTimes(65)
  await renderMermaidDiagram("graph 1", false)
  expect(mermaid.render).toHaveBeenCalledTimes(66)
})

test("large source strings consume the byte budget and oversized entries are not retained", async () => {
  const { renderMermaidDiagram } = await import("./mermaid.ts")
  const large = "x".repeat(1_100_000)
  await renderMermaidDiagram(`first ${large}`, false)
  await renderMermaidDiagram(`second ${large}`, false)
  await renderMermaidDiagram(`first ${large}`, false)
  expect(mermaid.render).toHaveBeenCalledTimes(3)
  const oversized = "x".repeat(2_100_000)
  await renderMermaidDiagram(oversized, false)
  await renderMermaidDiagram(oversized, false)
  expect(mermaid.render).toHaveBeenCalledTimes(5)
})
