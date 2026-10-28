import katex from "katex"
import MarkdownIt, { type Env } from "markdown-it"
import { isFileResource } from "./agent-resources.ts"
import { canHighlight, codeLanguageName, highlightFence } from "./code-highlight.ts"

// Raw HTML stays escaped; markdown-it's link validation also rejects script URLs.
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false })
const validate = markdown.validateLink.bind(markdown)
// File URLs are accepted only to turn them into application-owned resource controls.
markdown.validateLink = value => isFileResource(value) || validate(value)
const escapeHtml = markdown.utils.escapeHtml
const COPY_ICONS =
  '<svg data-icon-copy xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>' +
  '<svg data-icon-check xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>'

function renderMath(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex, { displayMode, throwOnError: true, strict: "ignore", trust: false })
  } catch {
    const raw = escapeHtml(displayMode ? `$$\n${tex}\n$$` : `$${tex}$`)
    return displayMode ? `<pre class="ui-math-fallback"><code>${raw}</code></pre>` : `<code class="ui-math-fallback">${raw}</code>`
  }
}

function renderMathBlock(tex: string, newline = true): string {
  const trimmed = tex.trim()
  const button = `<button type="button" class="ui-button-ghost ui-math-copy h-7 w-7 shrink-0 p-0" data-math-copy="${escapeHtml(trimmed)}" aria-label="Copy" title="Copy">${COPY_ICONS}</button>`
  return `<div class="ui-math-block" data-math-block>${button}${renderMath(trimmed, true)}</div>${newline ? "\n" : ""}`
}

function renderCodeBlock(code: string, info: string): string {
  const language = info.toLowerCase()
  const name = codeLanguageName(language) ?? info
  const label = name ? `<span class="ui-code-language">${escapeHtml(name)}</span>` : ""
  const button = `<button type="button" class="ui-button-ghost ui-code-copy h-7 w-7 shrink-0 p-0" data-code-copy="${escapeHtml(code)}" aria-label="Copy" title="Copy">${COPY_ICONS}</button>`
  let highlighted = escapeHtml(code)
  if (canHighlight(language)) {
    try { highlighted = highlightFence(code, language) } catch { highlighted = escapeHtml(code) }
  }
  return `<div class="ui-code-block" data-code-block><div class="ui-code-header">${label}${button}</div><pre><code>${highlighted}</code></pre></div>\n`
}

markdown.inline.ruler.before("escape", "math_bracket", (state, silent) => {
  const match = /^\\(?:\(([^\n]+?)\\\)|\[([\s\S]+?)\\\])/u.exec(state.src.slice(state.pos))
  const content = (match?.[1] ?? match?.[2])?.trim()
  if (!match || !content) return false
  if (!silent) state.push(match[2] ? "math_block_inline" : "math_inline", "math", 0).content = content
  state.pos += match[0].length
  return true
})

markdown.inline.ruler.after("escape", "math_dollar", (state, silent) => {
  if (state.src.charCodeAt(state.pos) !== 0x24) return false
  const tail = state.src.slice(state.pos)
  const block = /^\$\$([\s\S]+?)\$\$/u.exec(tail)
  if (block?.[1]?.trim()) {
    if (!silent) state.push("math_block_inline", "math", 0).content = block[1].trim()
    state.pos += block[0].length
    return true
  }
  const inline = /^\$(?!\s)((?:\\.|[^$\\\n])+?)(?<!\s)\$(?!\d)/u.exec(tail)
  if (!inline?.[1]) return false
  if (!silent) state.push("math_inline", "math", 0).content = inline[1]
  state.pos += inline[0].length
  return true
})

markdown.block.ruler.after("blockquote", "math_block", (state, startLine, endLine, silent) => {
  const pos = state.bMarks[startLine]! + state.tShift[startLine]!
  const match = /^(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])[ \t]*(?=\n|$)/u.exec(state.src.slice(pos, state.eMarks[endLine - 1]!))
  const content = (match?.[1] ?? match?.[2])?.trim()
  if (!match || !content) return false
  if (!silent) {
    state.line = startLine + match[0].split("\n").length
    state.push("math_block", "math", 0).content = content
  }
  return true
}, { alt: ["paragraph", "reference", "blockquote", "list"] })

markdown.renderer.rules.math_inline = (tokens, index) => `<span class="ui-math-inline" data-math-inline>${renderMath(tokens[index]!.content, false)}</span>`
markdown.renderer.rules.math_block_inline = (tokens, index) => renderMathBlock(tokens[index]!.content, false)
markdown.renderer.rules.math_block = (tokens, index) => renderMathBlock(tokens[index]!.content, true)

export interface MarkdownResource { id: string; uri: string; alt: string }
export interface MarkdownDiagram { id: string; code: string }
interface MarkdownEnvironment extends Env { resources: MarkdownResource[]; diagrams: MarkdownDiagram[] }
const image = markdown.renderer.rules.image!
markdown.renderer.rules.image = (tokens, index, options, environment, renderer) => {
  const resources = (environment as MarkdownEnvironment).resources
  const token = tokens[index]!
  const uri = String(token.attrGet("src") ?? "")
  if (!isFileResource(uri)) return image(tokens, index, options, environment, renderer)
  const id = String(resources.length)
  const alt = renderer.renderInlineAsText(token.children ?? [], options, environment)
  resources.push({ id, uri, alt })
  return `<span class="ui-remote-image" data-resource-image="${id}"></span>`
}
markdown.renderer.rules.link_open = (tokens, index, options, _environment, renderer) => {
  const token = tokens[index]!
  const uri = String(token.attrGet("href") ?? "")
  if (isFileResource(uri)) {
    token.attrSet("data-resource-link", uri)
    token.attrSet("href", "#")
  }
  return renderer.renderToken(tokens, index, options)
}
markdown.renderer.rules.fence = (tokens, index, _options, environment) => {
  const token = tokens[index]!
  const info = token.info.trim().split(/\s+/u)[0] ?? ""
  const lang = info.toLowerCase()
  if (lang === "mermaid") {
    const diagrams = (environment as MarkdownEnvironment).diagrams
    const id = String(diagrams.length)
    diagrams.push({ id, code: token.content.trim() })
    return `<div class="ui-mermaid" data-mermaid="${id}"><pre><code>${escapeHtml(token.content)}</code></pre></div>\n`
  }
  if (lang === "math" || lang === "latex" || lang === "tex" || lang === "katex") return renderMathBlock(token.content)
  return renderCodeBlock(token.content.replace(/\n$/u, ""), info)
}

export function renderResourceMarkdown(text: string): { html: string; resources: MarkdownResource[]; diagrams: MarkdownDiagram[] } {
  const environment: MarkdownEnvironment = { resources: [], diagrams: [] }
  return { html: markdown.render(text, environment), resources: environment.resources, diagrams: environment.diagrams }
}

/** Renders agent-authored Markdown into sanitized HTML. */
export function renderMarkdown(text: string): string {
  return renderResourceMarkdown(text).html
}
