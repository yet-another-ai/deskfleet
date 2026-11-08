import { getMarkdown, parseMarkdownToStructure, registerCacheStableLinkValidator, type MarkdownIt, type ParseOptions } from "markstream-vue"
import { isFileResource } from "./agent-resources.ts"

export const agentMarkdownParseOptions = {
  validateLink: url => isFileResource(url) || !/^(?:javascript|vbscript|data):/iu.test(url.trim()),
} satisfies ParseOptions

// This predicate depends only on its URL argument. Let the parser retain
// completed link nodes without opting arbitrary stateful callbacks into reuse.
registerCacheStableLinkValidator(agentMarkdownParseOptions.validateLink)

interface CitationInlineState {
  src: string
  pos: number
  posMax: number
  linkLevel: number
  push(type: string, tag: string, nesting: number): ReturnType<MarkdownIt["parse"]>[number]
}

/** Parse before typography/Markdown can change quoted paths or their punctuation. */
function fileCitation(state: CitationInlineState, silent: boolean): boolean {
  if (state.linkLevel > 0 || !state.src.startsWith(":codex-file-citation{", state.pos)) return false
  const match = state.src.slice(state.pos, state.posMax).match(/^:codex-file-citation\{((?:\s*[\w-]+\s*=\s*(?:"[^"\r\n]*"|'[^'\r\n]*'))+)\s*\}/u)
  if (!match) return false
  const paths = [...match[1]!.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)]
    .filter(attribute => attribute[1] === "path")
    .map(attribute => attribute[2] ?? attribute[3]!)
  const path = paths[0]
  if (paths.length !== 1 || !path || !isFileResource(path)) return false
  if (!silent) {
    // Encode literal filename segments, retaining separators and Windows drives.
    // In particular, '#' and ':12' are filename bytes here, not editor locations.
    const uri = /^file:/iu.test(path) ? path : path.replace(/[^/\\]+/gu, (part, offset) =>
      offset === 0 && /^[a-z]:$/iu.test(part) ? part : encodeURIComponent(part))
    const link = state.push("link_open", "a", 1)
    link.attrSet("href", uri)
    link.attrSet("title", path)
    state.push("text", "", 0).content = path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path
    state.push("link_close", "a", -1)
  }
  state.pos += match[0].length
  return true
}

/** One parser owns the incremental state of one mounted Markdown message. */
export function createAgentMarkdownParser(id: string) {
  // Configuring URL validation before parsing keeps the public streaming parser
  // available. MarkdownRender's general customMarkdownIt hook disables it even
  // when the hook only changes link validation.
  // MarkdownIt's validator also covers reference definitions; its options-only
  // override is applied by upstream to inline links but not references.
  // MarkdownIt's public validateLink method is omitted from Markstream's type.
  const markdown = getMarkdown(id) as ReturnType<typeof getMarkdown> & { validateLink: (url: string) => boolean }
  const validateLink = markdown.validateLink.bind(markdown)
  markdown.validateLink = url => isFileResource(url) || validateLink(url)
  // This deterministic inline rule emits ordinary links and keeps stream/node reuse.
  // Code spans, fenced blocks and escaped markers retain their normal Markdown meaning.
  markdown.inline.ruler.before("link", "deskfleet_file_citation", fileCitation)
  return (content: string, final: boolean) => parseMarkdownToStructure(content, markdown, {
    ...agentMarkdownParseOptions,
    final,
    streamParse: true,
    reuseStableTopLevelNodes: true,
  })
}
