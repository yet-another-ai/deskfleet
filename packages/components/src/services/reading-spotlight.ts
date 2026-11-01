/** Surfaces that opt into reading spotlight (markdown / chat prose). */
export const READING_SURFACE_ATTR = "data-reading-surface"

const BLOCK_SELECTOR = [
  "p", "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "pre", "blockquote", "table", "figure", "details",
  ".ui-code-block", ".ui-math-block", ".ui-mermaid", ".ui-preview", ".ui-markdown-segment",
].join(",")

export type SpotlightRect = { top: number; left: number; width: number; height: number }

export function findReadingSurface(el: Element | null): HTMLElement | null {
  return el?.closest<HTMLElement>(`[${READING_SURFACE_ATTR}]`) ?? null
}

/** Deepest block under the pointer that belongs to the reading surface. */
export function findSpotlightBlock(from: Element | null, surface: HTMLElement): HTMLElement | null {
  if (!from || !surface.contains(from)) return null
  if (from === surface) return surface

  let current: HTMLElement | null = from instanceof HTMLElement ? from : from.parentElement
  while (current && current !== surface) {
    if (current.matches(BLOCK_SELECTOR)) return current
    current = current.parentElement
  }
  // Plain chat text is the surface itself when it has no block children.
  if (!surface.querySelector(BLOCK_SELECTOR)) return surface
  return null
}

export function padSpotlightRect(rect: SpotlightRect, pad = 4): SpotlightRect {
  return {
    top: rect.top - pad,
    left: rect.left - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
  }
}

/** Line-level rect for paragraphs and plain text; whole block otherwise. */
export function spotlightRectForBlock(block: HTMLElement, clientY: number): SpotlightRect {
  const rect = block.getBoundingClientRect()
  const lineLevel = block.tagName === "P"
    || (block.hasAttribute(READING_SURFACE_ATTR) && !block.querySelector(BLOCK_SELECTOR))
  if (!lineLevel) {
    return { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
  }

  const lineHeight = Number.parseFloat(getComputedStyle(block).lineHeight)
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) {
    return { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
  }

  const lines = Math.max(1, Math.round(block.offsetHeight / lineHeight))
  const index = Math.min(lines - 1, Math.max(0, Math.floor((clientY - rect.top) / lineHeight)))
  return {
    top: rect.top + index * lineHeight,
    left: rect.left,
    width: rect.width,
    height: lineHeight,
  }
}
