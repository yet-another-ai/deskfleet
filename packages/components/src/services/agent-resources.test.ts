import { expect, test } from "vitest"
import { fileResourceLines, isFileResource } from "./agent-resources.ts"

test.each([
  "main.ts:0", "main.ts:2:0", "main.ts:0:2", "main.ts:02", "main.ts:2:03",
  "main.ts:9007199254740992", "main.ts:2:9007199254740992",
  "main.ts#L0", "main.ts#L02", "main.ts#L3-L2", "main.ts#L2-L0",
  "main.ts#L9007199254740992", "main.ts#L2-L9007199254740992", "main.ts#L2-Lx", "main.ts#L2#extra",
  "C:12", "C:12:3", "literal%23L2", "literal%3A2", "main.ts#preview",
])("does not invent a line selection for %s", uri => {
  expect(fileResourceLines(uri)).toBeUndefined()
})

test("a non-line fragment preserves a valid colon location without decoding the path", () => {
  expect(fileResourceLines("a%20b.ts:12:3#preview")).toEqual({ start: 12, end: 12 })
  expect(fileResourceLines("file:///a%23b.ts:12#L8")).toEqual({ start: 8, end: 8 })
})

test.each(["main.ts:12#L8", "main.ts:12:3#preview", "./main.ts#L12-L20", "C:/work/main.ts:12#L8"])("classifies %s as a file resource", uri => {
  expect(isFileResource(uri)).toBe(true)
})

test.each(["javascript:12#L8", "javascript:alert(1)#L12", "data:text/plain,test#L2", "https://example.org/main.ts:12#L8", "#L12"])("does not reinterpret the URL %s as a file resource", uri => {
  expect(isFileResource(uri)).toBe(false)
})
