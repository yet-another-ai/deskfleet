import * as markstream from "markstream-vue"
import { afterEach, expect, test, vi } from "vitest"
import { createAgentMarkdownParser } from "./agent-markdown.ts"

vi.mock("markstream-vue", async importOriginal => {
  const actual = await importOriginal<typeof import("markstream-vue")>()
  return { ...actual, getMarkdown: vi.fn(actual.getMarkdown) }
})

afterEach(() => vi.restoreAllMocks())

function links(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(links)
  if (!value || typeof value !== "object") return []
  const node = value as Record<string, unknown>
  return node.type === "link" ? [String(node.href)] : Object.values(node).flatMap(links)
}

test("file destinations are validated during tokenization, including angle-delimited and line references", () => {
  const parse = createAgentMarkdownParser("files")
  const destinations = ["file:///tmp/report.md", "file://server/share/report.md", "file:relative.md", "./src/main.ts#L12-L14", "main.ts:12:4", "/tmp/a%20b.md"]
  const text = destinations.map((destination, index) => `[source ${index}](<${destination}>)`).join("\n\n")
  expect(links(parse(text, true))).toEqual(destinations)
})

test("file support never turns script or data destinations into links", () => {
  const parse = createAgentMarkdownParser("unsafe")
  const text = [
    "[bad](javascript:alert(1))", "[bad](JaVaScRiPt:12)", "[bad](vbscript:12)",
    "[bad](data:text/html,test)", "[bad](javascript&#58;alert(1))",
    "[safe](https://example.org/a)", "[file](<file:relative.md>)",
  ].join("\n\n")
  for (const final of [false, true]) {
    expect(links(parse(text, final))).toEqual(["https://example.org/a", "file:relative.md"])
  }
})

test("protocol-relative external links preserve the existing URL-validation contract", () => {
  const parse = createAgentMarkdownParser("protocol-relative")
  const text = "[site](//example.org/path) [mail](mailto:team@example.org) [fragment](#section)"
  for (const final of [false, true]) {
    expect(links(parse(text, final))).toEqual(["//example.org/path", "mailto:team@example.org", "#section"])
  }
})

test("growing messages use the streaming tokenizer and retain eligible completed nodes", () => {
  const created = vi.mocked(markstream.getMarkdown).mockClear()
  const parse = createAgentMarkdownParser("stream")
  const markdown = created.mock.results[0]!.value as ReturnType<typeof markstream.getMarkdown>
  const sync = vi.spyOn(markdown, "parse")
  const stream = vi.spyOn(markdown.stream!, "parse")
  const first = parse("Completed **paragraph**.\n\nAnother paragraph.\n\n", false)
  const next = parse("Completed **paragraph**.\n\nAnother paragraph.\n\nNext paragraph.", false)
  expect(next[0]).toBe(first[0])
  expect(stream).toHaveBeenCalledTimes(2)
  expect(sync).not.toHaveBeenCalled()
})

test("completed paragraphs with file and external links retain node identity during streaming", () => {
  const parse = createAgentMarkdownParser("stable-links")
  const prefix = "[file](<file://server/share/report.md>) and [site](https://example.org).\n\nCompleted **paragraph**.\n\n"
  const first = parse(prefix, false)
  const next = parse(`${prefix}Next paragraph.`, false)
  expect(next[0]).toBe(first[0])
  expect(next[1]).toBe(first[1])
  expect(links(next)).toEqual(["file://server/share/report.md", "https://example.org"])
  const final = `${prefix}Next paragraph. **unfinished`
  expect(parse(final, true)).toEqual(createAgentMarkdownParser("fresh")(final, true))
})

test("unregistered stateful validators still revalidate completed links", () => {
  const markdown = markstream.getMarkdown("stateful")
  let allowed = true
  const options = { final: false, streamParse: true, reuseStableTopLevelNodes: true, validateLink: () => allowed }
  const prefix = "[site](https://example.org)\n\nCompleted paragraph.\n\n"
  expect(links(markstream.parseMarkdownToStructure(prefix, markdown, options))).toEqual(["https://example.org"])
  allowed = false
  expect(links(markstream.parseMarkdownToStructure(`${prefix}Next paragraph.`, markdown, options))).toEqual([])
})

test("streamed files and late reference definitions match a fresh completed parse", () => {
  const parse = createAgentMarkdownParser("references")
  const text = "[network](<file://server/share/report.md>)\n\n[relative](<file:relative.md>)\n\n[late][source]\n\n[source]: <file:///tmp/late.md>\n\n| Stage | Count |\n| --- | ---: |\n| Read | 1 |\n\n```ts\nconst done = true;\n```\n\nUnfinished **text"
  for (let end = 1; end < text.length; end += 7) parse(text.slice(0, end), false)
  const completed = parse(text, true)
  expect(links(completed)).toEqual(["file://server/share/report.md", "file:relative.md", "file:///tmp/late.md"])
  expect(completed).toEqual(createAgentMarkdownParser("fresh")(text, true))
})

test("replacement, clearing and a new stream after final do not retain prior parser state", () => {
  const parse = createAgentMarkdownParser("replacement")
  parse("[old][source]\n\n[source]: https://old.example\n\n", false)
  const replacement = "[new](<file:relative.md>)\n\nOnly replacement text."
  expect(parse(replacement, true)).toEqual(createAgentMarkdownParser("fresh")(replacement, true))
  expect(parse("", true)).toEqual([])
  expect(links(parse("[fresh][source]\n\n", false))).toEqual([])
  const next = "[fresh][source]\n\n[source]: https://new.example\n\n"
  expect(links(parse(next, false))).toEqual(["https://new.example"])
  expect(parse(next, true)).toEqual(createAgentMarkdownParser("fresh")(next, true))
})
