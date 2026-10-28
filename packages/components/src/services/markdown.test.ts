import { expect, test } from "vitest"
import { renderResourceMarkdown } from "./markdown.ts"

test("filesystem links become application resources without browser-local URLs", () => {
  const result = renderResourceMarkdown("![Chart](/tmp/chart.png) [Read](file:///tmp/report.md) [Code](./src/main.ts#L12)")
  expect(result.resources).toEqual([{ id: "0", uri: "/tmp/chart.png", alt: "Chart" }])
  expect(result.html).toContain('data-resource-image="0"')
  expect(result.html).not.toContain('src="/tmp/chart.png"')
  expect(result.html).toContain('data-resource-link="file:///tmp/report.md"')
  expect(result.html).toContain('data-resource-link="./src/main.ts#L12"')
  expect(result.html).not.toContain('href="file:')
})

test("filesystem recognition leaves script rejection and escaped HTML intact", () => {
  const result = renderResourceMarkdown('[bad](javascript:alert(1)) [bad](data:text/html,test) <img src="x" onerror="alert(1)"> [site](https://example.org/a)')
  expect(result.html).not.toContain('href="javascript:')
  expect(result.html).not.toContain('href="data:')
  expect(result.html).not.toContain('<img src="x"')
  expect(result.html).toContain("&lt;img")
  expect(result.html).toContain('href="https://example.org/a"')
  expect(result.resources).toEqual([])
})

test("resource attributes are escaped and public images retain their ordinary renderer", () => {
  const result = renderResourceMarkdown('![Remote](https://example.org/a.png) [file](</tmp/a"b.txt>)')
  expect(result.html).toContain('src="https://example.org/a.png"')
  expect(result.html).not.toContain('data-resource-link="/tmp/a"b.txt"')
  expect(result.html).toContain('data-resource-link="/tmp/a%22b.txt"')
})

test("line references stay on the session machine without accepting script schemes", () => {
  const result = renderResourceMarkdown("[line](main.ts:12:4) [path](/src/main.ts:12) [bad](javascript:12) [bad](data:text/plain:12)")
  expect(result.html).toContain('data-resource-link="main.ts:12:4"')
  expect(result.html).toContain('data-resource-link="/src/main.ts:12"')
  expect(result.html).not.toContain('href="javascript:')
  expect(result.html).not.toContain('href="data:')
  expect(result.html).not.toContain('data-resource-link="javascript:')
})

test("renders LaTeX inline, display, and fenced blocks while ignoring plain currency and invalid TeX", () => {
  const result = renderResourceMarkdown([
    "Inline $E = mc^2$ and \\(a^2 + b^2 = c^2\\), prices like $10 and $20, escaped \\$30.",
    "",
    "$$",
    "\\int_0^1 x^2 \\, dx = \\frac{1}{3}",
    "$$",
    "",
    "\\[",
    "\\sum_{i=1}^n i",
    "\\]",
    "",
    "```latex",
    "\\alpha + \\beta",
    "```",
    "",
    "Broken $\\invalidcommand{$ fallback.",
  ].join("\n"))
  expect(result.html).toContain("data-math-inline")
  expect(result.html).toContain("data-math-block")
  expect(result.html).toContain('data-math-copy="\\int_0^1 x^2 \\, dx = \\frac{1}{3}"')
  expect(result.html).toContain('data-math-copy="\\alpha + \\beta"')
  expect(result.html).toContain('class="katex"')
  expect(result.html).toContain('class="katex-display"')
  expect(result.html).toContain("prices like $10 and $20, escaped $30.")
  expect(result.html).toContain('class="ui-math-fallback"')
})

test("extracts mermaid code blocks with escaped source fallback", () => {
  const result = renderResourceMarkdown('```mermaid\ngraph TD\n  A["<script>"] --> B\n```')
  expect(result.diagrams).toEqual([{ id: "0", code: 'graph TD\n  A["<script>"] --> B' }])
  expect(result.html).toContain('data-mermaid="0"')
  expect(result.html).not.toContain("<script>")
  expect(result.html).toContain("&lt;script&gt;")
})
