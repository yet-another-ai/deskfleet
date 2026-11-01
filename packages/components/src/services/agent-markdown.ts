import { getMarkdown, parseMarkdownToStructure, registerCacheStableLinkValidator, type ParseOptions } from "markstream-vue"
import { isFileResource } from "./agent-resources.ts"

export const agentMarkdownParseOptions = {
  validateLink: url => isFileResource(url) || !/^(?:javascript|vbscript|data):/iu.test(url.trim()),
} satisfies ParseOptions

// This predicate depends only on its URL argument. Let the parser retain
// completed link nodes without opting arbitrary stateful callbacks into reuse.
registerCacheStableLinkValidator(agentMarkdownParseOptions.validateLink)

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
  return (content: string, final: boolean) => parseMarkdownToStructure(content, markdown, {
    ...agentMarkdownParseOptions,
    final,
    streamParse: true,
    reuseStableTopLevelNodes: true,
  })
}
