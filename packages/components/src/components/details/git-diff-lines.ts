export interface GitDiffLine {
  text: string
  kind: "meta" | "hunk" | "context" | "added" | "deleted"
  before?: number
  after?: number
}

/** Assign old and new line numbers for a unified diff patch. */
export function parseGitDiffLines(patch: string | undefined): GitDiffLine[] {
  if (!patch) return []
  const result: GitDiffLine[] = []
  let before = 0
  let after = 0
  let beforeLeft = 0
  let afterLeft = 0
  const source = patch.split("\n")
  if (source.at(-1) === "") source.pop()
  for (const text of source) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(text)
    if (hunk) {
      before = Number(hunk[1])
      after = Number(hunk[3])
      beforeLeft = Number(hunk[2] ?? 1)
      afterLeft = Number(hunk[4] ?? 1)
      result.push({ text, kind: "hunk" })
    } else if (beforeLeft > 0 && text.startsWith("-")) {
      result.push({ text, kind: "deleted", before: before++ })
      beforeLeft--
    } else if (afterLeft > 0 && text.startsWith("+")) {
      result.push({ text, kind: "added", after: after++ })
      afterLeft--
    } else if (beforeLeft > 0 && afterLeft > 0 && text.startsWith(" ")) {
      result.push({ text, kind: "context", before: before++, after: after++ })
      beforeLeft--
      afterLeft--
    } else result.push({ text, kind: "meta" })
  }
  return result
}
