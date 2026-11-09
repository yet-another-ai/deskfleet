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

test("Codex output citations become file links without interpreting filename punctuation as Markdown", () => {
  const parse = createAgentMarkdownParser("citations")
  const path = "/work/reports/output/方案_12页 [精简] #1 100%.pptx"
  const text = `已完成。\n\n:codex-file-citation{path="${path}" purpose="output"}\n\n- :codex-file-citation{purpose='input' path='./data.xlsx'}`
  const nodes = parse(text, true)
  expect(links(nodes)).toEqual([encodeURI(path).replace(/#/gu, "%23"), "./data.xlsx"])
  expect(nodes[1]).toMatchObject({ children: [{ type: "link", text: "方案_12页 [精简] #1 100%.pptx", title: path }] })
})

test.each([
  [String.raw`C:\Users\Alice\My Files\报告.pptx`, String.raw`C:\Users\Alice\My%20Files\%E6%8A%A5%E5%91%8A.pptx`],
  ["/work/report:12", "/work/report%3A12"],
])("citation paths preserve filesystem meaning: %s", (path, uri) => {
  expect(links(createAgentMarkdownParser("citation-path")(`:codex-file-citation{path="${path}"}`, true))).toEqual([uri])
})

test("code, escaped or incomplete citations and non-file paths do not become resource links", () => {
  const parse = createAgentMarkdownParser("literal-citations")
  const citation = ':codex-file-citation{path="/work/example.pptx" purpose="output"}'
  const text = [
    `\`${citation}\``, `\`\`\`text\n${citation}\n\`\`\``, `\\${citation}`,
    ':codex-file-citation{path="/work/incomplete.pptx"',
    ':codex-file-citation{purpose="output"}',
    ':codex-file-citation{path="/one" path="/two"}',
    ':codex-file-citation{path="javascript:alert(1)"}',
    ':codex-file-citation{path="https://example.org/report.pptx"}',
  ].join("\n\n")
  // Ordinary URL linkification still applies to text that is not a file citation.
  expect(links(parse(text, true))).toEqual(["https://example.org/report.pptx"])
})

test("citations completed across streaming chunks match a fresh parse and retain completed nodes", () => {
  const parse = createAgentMarkdownParser("stream-citations")
  const citation = ':codex-file-citation{path="/work/最终版本.pptx" purpose="output"}'
  for (let end = 1; end < citation.length; end++) {
    expect(links(parse(citation.slice(0, end), false))).toEqual([])
  }
  const prefix = `${citation}\n\nCompleted paragraph.\n\n`
  const first = parse(prefix, false)
  const next = parse(`${prefix}Next paragraph.`, false)
  expect(links(next)).toEqual([encodeURI("/work/最终版本.pptx")])
  expect(next[0]).toBe(first[0])
  expect(parse(`${prefix}Next paragraph.`, true)).toEqual(createAgentMarkdownParser("fresh-citations")(`${prefix}Next paragraph.`, true))
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
