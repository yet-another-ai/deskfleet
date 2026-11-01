import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { instantiateMermaidSvg } from "./mermaid-svg.ts"

function parse(svg: string) {
  return new DOMParser().parseFromString(svg, "image/svg+xml")
}

const selectorDescriptor = Object.getOwnPropertyDescriptor(CSSStyleRule.prototype, "selectorText")!
const cssTextDescriptor = Object.getOwnPropertyDescriptor(CSSStyleRule.prototype, "cssText")!
afterEach(() => {
  Object.defineProperty(CSSStyleRule.prototype, "selectorText", selectorDescriptor)
  Object.defineProperty(CSSStyleRule.prototype, "cssText", cssTextDescriptor)
})

beforeEach(() => {
  // Happy DOM's HTML parser truncates SVG at <style>. Use its XML parser for
  // these well-formed fixtures; Electron benchmarks exercise real HTML parsing,
  // including Mermaid's foreignObject labels. Keep that workaround out of runtime.
  const dom = document as { createElement: (name: string, options?: ElementCreationOptions) => HTMLElement }
  const createElement = dom.createElement.bind(document)
  vi.spyOn(dom, "createElement").mockImplementation((name, options) => {
    if (name !== "template") return createElement(name, options)
    let content: Document
    return {
      set innerHTML(value: string) { content = parse(value) },
      get innerHTML() { return new XMLSerializer().serializeToString(content) },
      get content() { return content },
    } as unknown as HTMLTemplateElement
  })
  // Happy DOM also lacks the browser's writable CSSStyleRule.selectorText.
  Object.defineProperty(CSSStyleRule.prototype, "selectorText", {
    ...selectorDescriptor,
    set(this: CSSStyleRule, value: string) { Object.defineProperty(this, "selectorText", { value, writable: true, configurable: true }) },
  })
  Object.defineProperty(CSSStyleRule.prototype, "cssText", {
    ...cssTextDescriptor,
    get(this: CSSStyleRule) {
      const original = cssTextDescriptor.get!.call(this) as string
      const selector = selectorDescriptor.get!.call(this) as string
      return this.selectorText + original.slice(selector.length)
    },
  })
})

const source = `<svg id="diagram" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" aria-labelledby="title other" aria-describedby="description">
  <title id="title">diagram #fff url(#fff)</title><desc id="description">Description</desc>
  <defs><marker id="fff"/><clipPath id="clip"/></defs>
  <path id="node" marker-end="url(#fff)" clip-path="url('#clip')" fill="#fff" data-label="url(#fff)" style="filter: url(#clip); fill: #fff"/>
  <use href="#node"/><use xlink:href="#node"/>
  <a href="https://example.com/other#node"><text>node #fff</text></a>
  <style>#diagram #node, #fff:hover, #fff-other { fill: #fff; marker-end: url(#fff); } #diagram::after { content: "url(#fff) #node"; } @media (min-width: 1px) { #node { clip-path: url('#clip'); } }</style>
</svg>`

test("cached SVG instances have distinct IDs and preserve local reference targets", () => {
  const first = parse(instantiateMermaidSvg(source, "first"))
  const second = parse(instantiateMermaidSvg(source, "second"))
  const firstIds = [...first.querySelectorAll("[id]")].map(element => element.id)
  const secondIds = [...second.querySelectorAll("[id]")].map(element => element.id)
  expect(new Set([...firstIds, ...secondIds]).size).toBe(firstIds.length + secondIds.length)
  expect(first.querySelector("svg")!.getAttribute("aria-labelledby")).toBe("first-1 other")
  expect(first.querySelector("svg")!.getAttribute("aria-describedby")).toBe("first-2")
  expect(first.querySelector("path")!.getAttribute("marker-end")).toBe('url("#first-3")')
  expect(first.querySelector("path")!.getAttribute("clip-path")).toBe('url("#first-4")')
  expect([...first.querySelectorAll("use")].map(element => element.getAttribute("href") ?? element.getAttribute("xlink:href"))).toEqual(["#first-5", "#first-5"])
  expect(first.querySelector("path")!.style.filter).toContain("#first-4")
})

test("rewrites CSS selectors and declarations without changing colors, strings, or selector prefixes", () => {
  const result = parse(instantiateMermaidSvg(source, "copy"))
  const css = result.querySelector("style")!.textContent!
  expect(css).toContain("#copy-0 #copy-5")
  expect(css).toContain("#copy-3:hover")
  expect(css).toContain("#fff-other")
  expect(css).toContain("#copy-4")
  expect(css).toContain("fill: #fff")
  expect(css).toContain('content: "url(#fff) #node"')
  expect(result.querySelector("title")!.textContent).toBe("diagram #fff url(#fff)")
  expect(result.querySelector("text")!.textContent).toBe("node #fff")
  expect(result.querySelector("path")!.getAttribute("data-label")).toBe("url(#fff)")
  expect(result.querySelector("path")!.getAttribute("fill")).toBe("#fff")
  expect(result.querySelector("a")!.getAttribute("href")).toBe("https://example.com/other#node")
})

test("rewrites same-document absolute marker URLs and preserves external references", () => {
  const sameDocument = new URL(document.URL)
  sameDocument.hash = "node"
  const svg = `<svg><g id="node"/><path marker-end="url('${sameDocument.href}')"/><use href="${sameDocument.href}"/><use href="https://example.com/other#node"/></svg>`
  const result = parse(instantiateMermaidSvg(svg, "copy"))
  expect(result.querySelector("path")!.getAttribute("marker-end")).toBe('url("#copy-0")')
  expect(result.querySelectorAll("use")[0]!.getAttribute("href")).toBe("#copy-0")
  expect(result.querySelectorAll("use")[1]!.getAttribute("href")).toBe("https://example.com/other#node")
})

test.each([
  "http://localhost:5173/#/sessions/original",
  "file:///C:/Program%20Files/DeskFleet/index.html#/sessions/original",
])("rewrites markers appended to hash route %s while preserving other routes", sourceDocumentUrl => {
  const markerUrl = `${sourceDocumentUrl}#node`
  const otherRoute = sourceDocumentUrl.replace("/original", "/another") + "#node"
  const external = "https://example.com/#/sessions/original#node"
  const svg = `<svg xmlns="http://www.w3.org/2000/svg"><marker id="node"/><path marker-end="url('${markerUrl}')" style="filter: url('${markerUrl}')"/>
    <use href="${markerUrl}"/><use href="${otherRoute}"/><use href="${external}"/>
    <style>path { clip-path: url('${markerUrl}'); }</style></svg>`
  const result = parse(instantiateMermaidSvg(svg, "copy", sourceDocumentUrl))
  expect(result.querySelector("path")!.getAttribute("marker-end")).toBe('url("#copy-0")')
  expect(result.querySelector("path")!.style.filter).toContain("#copy-0")
  expect(result.querySelector("style")!.textContent).toContain("#copy-0")
  expect([...result.querySelectorAll("use")].map(element => element.getAttribute("href"))).toEqual(["#copy-0", otherRoute, external])
})

test("matches escaped CSS IDs without rewriting escaped class hashes or quoted strings", () => {
  const svg = `<svg id="a:b"><style>#a\\:b, .\\#a, [data-label="#a:b"] { fill: red; }</style></svg>`
  const result = parse(instantiateMermaidSvg(svg, "copy"))
  const css = result.querySelector("style")!.textContent!
  expect(css).toContain("#copy-0")
  expect(css).toContain(".\\#a")
  expect(css).toContain('[data-label="#a:b"]')
})

test("rewrites exact ID and fragment attribute selectors while preserving unrelated attribute values", () => {
  const svg = `<svg id="diagram"><g id="node"/><style>
    [id="node"], [id='node'], [id=node], [id="n\\ode"], [id=n\\ode] { fill: red; }
    [href="#node"], [href='\\#node'], [href=\\#node], [xlink\\:href="#node"] { stroke: blue; }
    [data-label="#node"], [data-label=\\#node], [id^="node"], [href="https://example.com/#node"] { opacity: .5; }
  </style></svg>`
  const result = parse(instantiateMermaidSvg(svg, "copy"))
  const css = result.querySelector("style")!.textContent!
  expect(css).toContain('[id="copy-1"]')
  expect(css.match(/\[id="copy-1"\]/gu)).toHaveLength(5)
  expect(css.match(/\[href="\\#copy-1"\]/gu)).toHaveLength(3)
  expect(css).toContain('[xlink\\:href="\\#copy-1"]')
  expect(css).toContain('[data-label="#node"]')
  expect(css).toContain('[data-label=\\#node]')
  expect(css).toContain('[id^="node"]')
  expect(css).toContain('[href="https://example.com/#node"]')
})
