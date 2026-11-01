const urlAttributes = new Set(["fill", "stroke", "clip-path", "mask", "filter", "marker-start", "marker-mid", "marker-end", "cursor"])
const idListAttributes = new Set(["aria-labelledby", "aria-describedby"])

function unescapeCss(value: string): string {
  return value.replace(/\\([\da-f]{1,6})(?:\s)?|\\([^\n\r\f])/giu, (_, hex: string | undefined, character: string) => {
    if (!hex) return character
    const codePoint = Number.parseInt(hex, 16)
    return String.fromCodePoint(codePoint > 0 && codePoint <= 0x10ffff ? codePoint : 0xfffd)
  })
}

/** Give a cached, already-sanitized Mermaid SVG its own document IDs. */
export function instantiateMermaidSvg(svg: string, instanceId: string, sourceDocumentUrl = document.URL): string {
  const template = document.createElement("template")
  template.innerHTML = svg
  const ids = new Map<string, string>()
  for (const element of template.content.querySelectorAll("[id]")) {
    const id = element.id
    if (!ids.has(id)) ids.set(id, `${instanceId}-${ids.size}`)
  }
  const documentUrl = new URL(sourceDocumentUrl)
  const markerPrefix = `${documentUrl.href}#`
  documentUrl.hash = ""

  function reference(value: string): string {
    if (value.startsWith("#")) {
      const id = ids.get(value.slice(1))
      return id ? `#${id}` : value
    }
    // Mermaid can append #marker to document.URL, including its hash route.
    // Match that complete captured URL before treating a hash as the SVG ID.
    // External documents with coincidentally matching fragments stay external.
    try {
      const url = new URL(value, document.baseURI)
      const fragment = url.href.startsWith(markerPrefix) ? url.href.slice(markerPrefix.length) : url.hash.slice(1)
      url.hash = ""
      const id = ids.get(fragment)
      return id && url.href === documentUrl.href ? `#${id}` : value
    } catch { return value }
  }

  function urls(value: string): string {
    // Consume quoted strings as whole tokens, so CSS content strings remain text.
    return value.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s)'"\r\n]+))\s*\)/giu,
      (match, double: string | undefined, single: string | undefined, bare: string | undefined) => {
        const source = double ?? single ?? bare
        if (source === undefined) return match
        const target = reference(unescapeCss(source))
        return target === unescapeCss(source) ? match : `url("${target}")`
      },
    )
  }

  function selectors(value: string): string {
    // Consume whole attribute selectors and strings so unrelated attribute
    // values and escaped hashes in class names cannot be mistaken for IDs.
    return value.replace(/\[(?:\\.|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\]"'\\])*\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\\(?:[\da-f]{1,6}\s?|[^\n\r\f])|#((?:\\[\da-f]{1,6}\s?|\\[^\n\r\f]|[\w-]|[^\x00-\x7f])+)/giu,
      (match, id: string | undefined) => {
        if (match.startsWith("[")) return attributeSelector(match)
        const replacement = id === undefined ? undefined : ids.get(unescapeCss(id))
        return replacement ? `#${CSS.escape(replacement)}` : match
      },
    )
  }

  function attributeSelector(value: string): string {
    // Match only exact ID/reference comparisons, not substring operators or
    // arbitrary user-authored data attributes. CSS escapes can occur in names
    // (xlink\:href) and in quoted or unquoted values.
    const parts = value.match(/^\[\s*((?:\\[\da-f]{1,6}\s?|\\[^\n\r\f]|[\w-]|[^\x00-\x7f])+)\s*=\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|((?:\\[\da-f]{1,6}\s?|\\[^\n\r\f]|[^\s\]"'\\])+))\s*([is])?\s*\]$/iu)
    if (!parts) return value
    const name = unescapeCss(parts[1]!).toLowerCase()
    const original = unescapeCss(parts[2] ?? parts[3] ?? parts[4]!)
    const rewritten = name === "id" ? ids.get(original) ?? original
      : name === "href" || name === "xlink:href" ? reference(original) : original
    if (rewritten === original) return value
    return `[${parts[1]}="${CSS.escape(rewritten)}"${parts[5] ? ` ${parts[5]}` : ""}]`
  }

  function declarations(style: CSSStyleDeclaration): void {
    for (let index = 0; index < style.length; index++) {
      const property = style.item(index)
      const original = style.getPropertyValue(property)
      const rewritten = urls(original)
      if (rewritten !== original) style.setProperty(property, rewritten, style.getPropertyPriority(property))
    }
  }

  function rules(entries: CSSRuleList): void {
    for (const rule of entries) {
      if ("selectorText" in rule) {
        const styleRule = rule as CSSStyleRule
        styleRule.selectorText = selectors(styleRule.selectorText)
      }
      if ("style" in rule) declarations((rule as CSSStyleRule).style)
      if ("cssRules" in rule) rules((rule as CSSGroupingRule).cssRules)
    }
  }

  for (const element of template.content.querySelectorAll<SVGElement>("*")) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name
      const value = attribute.value
      let rewritten = value
      if (name === "id") rewritten = ids.get(value)!
      else if (name === "href" || name === "xlink:href") rewritten = reference(value)
      else if (idListAttributes.has(name)) rewritten = value.replace(/\S+/gu, id => ids.get(id) ?? id)
      else if (urlAttributes.has(name)) rewritten = urls(value)
      if (rewritten !== value) element.setAttributeNS(attribute.namespaceURI, name, rewritten)
    }
    if (element.hasAttribute("style")) declarations(element.style)
    if (element.localName === "style") {
      const sheet = new CSSStyleSheet()
      sheet.replaceSync(element.textContent ?? "")
      rules(sheet.cssRules)
      element.textContent = [...sheet.cssRules].map(rule => rule.cssText).join("\n")
    }
  }
  return template.innerHTML
}
