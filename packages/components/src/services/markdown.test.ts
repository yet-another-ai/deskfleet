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
  expect(result.html).toContain('&lt;img')
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
  const result = renderResourceMarkdown('[line](main.ts:12:4) [path](/src/main.ts:12) [bad](javascript:12) [bad](data:text/plain:12)')
  expect(result.html).toContain('data-resource-link="main.ts:12:4"')
  expect(result.html).toContain('data-resource-link="/src/main.ts:12"')
  expect(result.html).not.toContain('href="javascript:')
  expect(result.html).not.toContain('href="data:')
  expect(result.html).not.toContain('data-resource-link="javascript:')
})
