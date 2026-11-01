import { afterEach, expect, test } from "vitest"
import {
  findReadingSurface, findSpotlightBlock, padSpotlightRect, READING_SURFACE_ATTR, spotlightRectForBlock,
} from "./reading-spotlight.ts"

afterEach(() => {
  document.body.replaceChildren()
})

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
  expect(findSpotlightBlock(bold, surface)).toBe(paragraph)
})

test("uses the surface itself for plain chat text", () => {
  const surface = document.createElement("div")
  surface.setAttribute(READING_SURFACE_ATTR, "")
  surface.textContent = "plain message"
  document.body.append(surface)
  expect(findSpotlightBlock(surface, surface)).toBe(surface)
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
