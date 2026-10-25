import MarkdownIt, { type Env } from "markdown-it"
import { isFileResource } from "./agent-resources.ts"

// Raw HTML stays escaped; markdown-it's link validation also rejects script URLs.
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false })
const validate = markdown.validateLink.bind(markdown)
// File URLs are accepted only to turn them into application-owned resource controls.
markdown.validateLink = value => isFileResource(value) || validate(value)
export interface MarkdownResource { id: string; uri: string; alt: string }
interface MarkdownEnvironment extends Env { resources: MarkdownResource[] }
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

export function renderResourceMarkdown(text: string): { html: string; resources: MarkdownResource[] } {
  const environment: MarkdownEnvironment = { resources: [] }
  return { html: markdown.render(text, environment), resources: environment.resources }
}

/** Renders agent-authored Markdown into sanitized HTML. */
export function renderMarkdown(text: string): string {
  return renderResourceMarkdown(text).html
}
