import MarkdownIt from "markdown-it"

// Raw HTML stays escaped; markdown-it's link validation also rejects script URLs.
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false })

/** Renders agent-authored Markdown into sanitized HTML. */
export function renderMarkdown(text: string): string {
  return markdown.render(text)
}
