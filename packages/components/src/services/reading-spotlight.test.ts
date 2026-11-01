import { afterEach, expect, test } from "vitest"
import {
  findReadingSurface, findSpotlightBlock, padSpotlightRect, READING_SURFACE_ATTR, spotlightRectForBlock,
} from "./reading-spotlight.ts"

afterEach(() => {
  document.body.replaceChildren()
})

function mockRect(el: HTMLElement, top: number, height: number, left = 0, width = 200): void {
  el.getBoundingClientRect = () => ({
    x: left, y: top, top, left, width, height, right: left + width, bottom: top + height, toJSON() { return this },
  })
}

test("finds the reading surface ancestor", () => {
  const surface = document.createElement("div")
  surface.setAttribute(READING_SURFACE_ATTR, "")
  const child = document.createElement("p")
  child.textContent = "Hello"
  surface.append(child)
  document.body.append(surface)
  expect(findReadingSurface(child)).toBe(surface)
  expect(findReadingSurface(document.body)).toBeNull()
})

test("selects the deepest block under the pointer", () => {
  const surface = document.createElement("div")
  surface.setAttribute(READING_SURFACE_ATTR, "")
  const paragraph = document.createElement("p")
  const bold = document.createElement("strong")
  bold.textContent = "focus"
  paragraph.append(bold)
  surface.append(paragraph)
  document.body.append(surface)
  expect(findSpotlightBlock(bold, surface, 10)).toBe(paragraph)
})

test("uses the surface itself for plain chat text", () => {
  const surface = document.createElement("div")
  surface.setAttribute(READING_SURFACE_ATTR, "")
  surface.textContent = "plain message"
  document.body.append(surface)
  expect(findSpotlightBlock(surface, surface, 10)).toBe(surface)
})

test("keeps the nearest paragraph when the pointer is on an inter-block gap", () => {
  const surface = document.createElement("div")
  surface.setAttribute(READING_SURFACE_ATTR, "")
  const first = document.createElement("p")
  first.textContent = "first"
  const second = document.createElement("p")
  second.textContent = "second"
  surface.append(first, second)
  document.body.append(surface)
  mockRect(first, 100, 20)
  mockRect(second, 140, 20)

  // Gap between blocks hits the surface (margin collapse / empty space).
  expect(findSpotlightBlock(surface, surface, 125)).toBe(first)
  expect(findSpotlightBlock(surface, surface, 135)).toBe(second)
})

test("keeps the nearest paragraph when the pointer is on a markdown wrapper", () => {
  const surface = document.createElement("div")
  surface.setAttribute(READING_SURFACE_ATTR, "")
  const renderer = document.createElement("div")
  renderer.className = "markdown-renderer"
  const slot = document.createElement("div")
  slot.className = "node-slot"
  const content = document.createElement("div")
  content.className = "node-content"
  const first = document.createElement("p")
  first.textContent = "first"
  const second = document.createElement("p")
  second.textContent = "second"
  content.append(first, second)
  slot.append(content)
  renderer.append(slot)
  surface.append(renderer)
  document.body.append(surface)
  mockRect(first, 100, 20)
  mockRect(second, 140, 20)

  expect(findSpotlightBlock(content, surface, 122)).toBe(first)
  expect(findSpotlightBlock(renderer, surface, 138)).toBe(second)
  expect(findSpotlightBlock(slot, surface, 130)).toBe(first)
})

test("prefers a nested list item over its parent list when distances tie", () => {
  const surface = document.createElement("div")
  surface.setAttribute(READING_SURFACE_ATTR, "")
  const list = document.createElement("ul")
  const item = document.createElement("li")
  item.textContent = "item"
  list.append(item)
  surface.append(list)
  document.body.append(surface)
  mockRect(list, 100, 40)
  mockRect(item, 110, 20)

  // Wrapper hit with Y inside both the list and the item.
  expect(findSpotlightBlock(surface, surface, 120)).toBe(item)
})

test("pads spotlight rectangles evenly", () => {
  expect(padSpotlightRect({ top: 10, left: 20, width: 100, height: 24 }, 4)).toEqual({
    top: 6, left: 16, width: 108, height: 32,
  })
})

test("resolves a line-level rect inside a paragraph", () => {
  const surface = document.createElement("div")
  surface.setAttribute(READING_SURFACE_ATTR, "")
  const paragraph = document.createElement("p")
  paragraph.textContent = "one\ntwo\nthree"
  paragraph.style.margin = "0"
  paragraph.style.lineHeight = "20px"
  paragraph.style.width = "200px"
  surface.append(paragraph)
  document.body.append(surface)
  Object.defineProperty(paragraph, "offsetHeight", { configurable: true, get: () => 60 })
  paragraph.getBoundingClientRect = () => ({
    x: 0, y: 100, top: 100, left: 40, width: 200, height: 60, right: 240, bottom: 160, toJSON() { return this },
  })
  expect(spotlightRectForBlock(paragraph, 125)).toEqual({ top: 120, left: 40, width: 200, height: 20 })
})
