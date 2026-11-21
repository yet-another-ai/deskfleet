import { expect, test } from "vitest"
import { parseCsvPreview } from "./csv-preview.ts"

test("preserves CSV field text, quoting, empty cells and ragged rows", () => {
  const input = '\uFEFFid,note,extra\r\n01,"東京, ""quoted""\r\nline",\r\n,,\n\n  x  \rlast,'
  expect(parseCsvPreview(input)).toEqual({
    rows: [
      ["id", "note", "extra"],
      ["01", '東京, "quoted"\r\nline', ""],
      ["", "", ""],
      [""],
      ["  x  "],
      ["last", ""],
    ],
    columnCount: 3,
    truncated: false,
  })
})

test("distinguishes an empty file from an explicitly empty record", () => {
  expect(parseCsvPreview("\uFEFF")).toEqual({ rows: [], columnCount: 0, truncated: false })
  expect(parseCsvPreview('""\r\n')).toEqual({ rows: [[""]], columnCount: 1, truncated: false })
})

test("caps columns and skips embedded line breaks in omitted fields", () => {
  const cells = Array.from({ length: 50 }, (_, index) => `cell-${index}`)
  const input = `${cells.join(",")},"omitted\r\nfield",\r\nnext,`
  expect(parseCsvPreview(input)).toEqual({ rows: [cells, ["next", ""]], columnCount: 50, truncated: true })
})

test("stops parsing when the displayed record limit is reached", () => {
  const cells = Array.from({ length: 200 }, (_, index) => `record-${index}`)
  const input = `${cells.join("\r\n")}\r\n`
  const expected = { rows: cells.map(cell => [cell]), columnCount: 1 }
  expect(parseCsvPreview(input)).toEqual({ ...expected, truncated: false })
  expect(parseCsvPreview(`${input}"unterminated`)).toEqual({ ...expected, truncated: true })
})

test.each(['a,"unterminated', 'a,"b"c', 'a,b"c'])("rejects malformed quoting in %s", input => {
  expect(() => parseCsvPreview(input)).toThrow(/CSV contains/)
})
