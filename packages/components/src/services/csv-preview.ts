const MAX_ROWS = 200
const MAX_COLUMNS = 50

export function parseCsvPreview(text: string): { rows: string[][]; columnCount: number; truncated: boolean } {
  const rows: string[][] = []
  let columnCount = 0
  let truncated = false
  let cursor = text.startsWith("\uFEFF") ? 1 : 0
  while (cursor < text.length && rows.length < MAX_ROWS) {
    const row: string[] = []
    for (;;) {
      const keep = row.length < MAX_COLUMNS
      if (text[cursor] === '"') {
        const start = ++cursor
        let close = text.indexOf('"', start)
        while (close !== -1 && text[close + 1] === '"') close = text.indexOf('"', close + 2)
        if (close === -1) throw new Error("CSV contains an unterminated quoted field")
        if (keep) row.push(text.slice(start, close).replaceAll('""', '"'))
        cursor = close + 1
      } else {
        const start = cursor
        while (cursor < text.length && !'",\r\n'.includes(text[cursor]!)) cursor++
        if (keep) row.push(text.slice(start, cursor))
      }
      if (!keep) truncated = true

      const separator = text[cursor]
      if (separator === ",") {
        cursor++
        continue
      }
      if (separator === "\r") cursor += text[cursor + 1] === "\n" ? 2 : 1
      else if (separator === "\n") cursor++
      else if (separator !== undefined) throw new Error("CSV contains unexpected characters after a field")
      break
    }
    rows.push(row)
    columnCount = Math.max(columnCount, row.length)
  }
  return { rows, columnCount, truncated: truncated || cursor < text.length }
}
