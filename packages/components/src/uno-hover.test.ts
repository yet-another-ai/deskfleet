import { createGenerator } from "unocss"
import { expect, test } from "vitest"
import config from "../uno.config.ts"

function extractHoverBlocks(css: string): { inside: string; outside: string } {
  const inside: string[] = []
  let outside = ""
  const marker = /@media\s*\(hover:\s*hover\)\s*\{/g
  let cursor = 0
  for (let match = marker.exec(css); match; match = marker.exec(css)) {
    outside += css.slice(cursor, match.index)
    let depth = 1
    let index = match.index + match[0].length
    while (index < css.length && depth > 0) {
      if (css[index] === "{") depth += 1
      else if (css[index] === "}") depth -= 1
      index += 1
    }
    inside.push(css.slice(match.index, index))
    cursor = index
    marker.lastIndex = index
  }
  outside += css.slice(cursor)
  return { inside: inside.join("\n"), outside }
}

test("UnoCSS gates hover and can-hover utilities behind @media (hover: hover)", async () => {
  const uno = await createGenerator(config)
  const { css } = await uno.generate([
    "hover:bg-ui-hover",
    "group-hover:op-100",
    "group-hover/worked:opacity-100",
    "ui-nav-item",
    "hidden",
    "can-hover:flex",
    "can-hover:op-0",
    "can-hover:pointer-events-none",
    "can-hover:group-focus-within:op-0",
  ].join(" "), { preflights: false })

  const { inside, outside } = extractHoverBlocks(css)
  expect(inside).toContain(".hover\\:bg-ui-hover:hover")
  expect(inside).toContain(".group:hover .group-hover\\:op-100")
  expect(inside).toContain(".group\\/worked:hover .group-hover\\/worked\\:opacity-100")
  expect(inside).toContain(".ui-nav-item:not(.ui-nav-active):hover")
  expect(inside).toContain(".can-hover\\:flex")
  expect(inside).toContain(".can-hover\\:op-0")
  expect(inside).toContain(".can-hover\\:pointer-events-none")
  expect(inside).toContain(".can-hover\\:group-focus-within\\:op-0")

  // `can-hover:flex` must appear after `.hidden` so hover-capable devices override `display: none`.
  expect(css.indexOf(".can-hover\\:flex")).toBeGreaterThan(css.indexOf(".hidden{"))

  // Ensure no unguarded :hover rules escape outside @media (hover: hover).
  expect(outside).not.toMatch(/(?<!\\):hover\b/)
})
