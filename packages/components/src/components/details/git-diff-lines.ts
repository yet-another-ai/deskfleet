import { countLines, type ComposerAttachment } from "../../services/composer-attachments.ts"
import type { GitFileDiff } from "../../../../../apps/daemon/src/git-protocol.ts"

export interface GitDiffLine {
  text: string
  kind: "meta" | "hunk" | "context" | "added" | "deleted"
  before?: number
  after?: number
}

export interface GitDiffLineSelection {
  startIndex: number
  endIndex: number
}

/** Whether a parsed diff line can be selected for an inline comment. */
export function isCommentableDiffLine(line: GitDiffLine | undefined): boolean {
  return Boolean(line && line.kind !== "meta" && line.kind !== "hunk")
}

function trimSelection(lines: readonly GitDiffLine[], start: number, end: number): GitDiffLineSelection | null {
  let s = Math.max(0, start)
  let e = Math.min(lines.length - 1, end)
  while (s <= e && !isCommentableDiffLine(lines[s])) s++
  while (e >= s && !isCommentableDiffLine(lines[e])) e--
  return s <= e ? { startIndex: s, endIndex: e } : null
}

/** Normalize an anchor/focus selection range onto commentable diff lines. */
export function normalizeDiffSelection(lines: readonly GitDiffLine[], anchorIndex: number, focusIndex: number): GitDiffLineSelection | null {
  return isCommentableDiffLine(lines[anchorIndex]) ? trimSelection(lines, Math.min(anchorIndex, focusIndex), Math.max(anchorIndex, focusIndex)) : null
}

/** Format a line range label such as `L10` or `L10-L15` for selected diff lines. */
export function formatDiffSelectionLabel(lines: readonly GitDiffLine[], selection: GitDiffLineSelection): string {
  const picked = lines.slice(selection.startIndex, selection.endIndex + 1).filter(isCommentableDiffLine)
  const first = picked[0]?.after ?? picked[0]?.before
  const last = picked.at(-1)?.after ?? picked.at(-1)?.before
  return first === undefined || last === undefined ? "" : first === last ? `L${first}` : `L${first}-L${last}`
}

const diffKey = (diff: Pick<GitFileDiff, "path" | "kind">) => `${diff.kind}:${diff.path}`

/** Build a composer attachment for selected diff lines. */
export function createDiffAttachment(
  diff: Pick<GitFileDiff, "path" | "kind">,
  lines: readonly GitDiffLine[],
  selection: GitDiffLineSelection,
  id: string = crypto.randomUUID(),
): Extract<ComposerAttachment, { kind: "pasted_text" }> {
  const selected = lines.slice(selection.startIndex, selection.endIndex + 1).filter(isCommentableDiffLine)
  const range = formatDiffSelectionLabel(lines, selection)
  const label = range ? `${diff.path} · ${range}` : diff.path
  const text = [`@@ ${diff.path} (${diff.kind}${range ? `, ${range}` : ""}) @@`, ...selected.map(line => line.text)].join("\n")
  return {
    id, kind: "pasted_text", label, uri: `deskfleet://git-diff/${encodeURIComponent(label)}`, text, lines: countLines(text),
    diff: { key: diffKey(diff), startIndex: selection.startIndex, endIndex: selection.endIndex },
  }
}

/** Collect all line indices already attached for `(diff.path, diff.kind)`. */
export function selectedDiffLineIndices(
  current: readonly ComposerAttachment[],
  diff: Pick<GitFileDiff, "path" | "kind">,
  lines: readonly GitDiffLine[],
): Set<number> {
  const key = diffKey(diff)
  const indices = new Set<number>()
  for (const item of current) {
    if (item.kind !== "pasted_text" || item.diff?.key !== key) continue
    for (let i = Math.max(0, item.diff.startIndex); i <= Math.min(lines.length - 1, item.diff.endIndex); i++) indices.add(i)
  }
  return indices
}

/** Sync composer attachments for `(diff.path, diff.kind)` to match contiguous ranges in `indices`. */
export function syncDiffAttachments(
  current: readonly ComposerAttachment[],
  diff: Pick<GitFileDiff, "path" | "kind">,
  lines: readonly GitDiffLine[],
  indices: Iterable<number>,
): ComposerAttachment[] {
  const sorted = [...new Set(indices)].filter(i => i >= 0 && i < lines.length).sort((a, b) => a - b)
  const ranges: GitDiffLineSelection[] = []
  for (let i = 0; i < sorted.length;) {
    const start = sorted[i]!
    let end = start
    while (i + 1 < sorted.length && sorted[i + 1] === end + 1) end = sorted[++i]!
    i++
    const trimmed = trimSelection(lines, start, end)
    if (trimmed) ranges.push(trimmed)
  }

  const key = diffKey(diff)
  const existingIds: string[] = []
  const attachments: ComposerAttachment[] = []
  let insertAt = -1
  for (const item of current) {
    if (item.kind === "pasted_text" && item.diff?.key === key) {
      if (insertAt === -1) insertAt = attachments.length
      existingIds.push(item.id)
    } else {
      attachments.push(item)
    }
  }

  if (!ranges.length) return attachments
  attachments.splice(insertAt === -1 ? attachments.length : insertAt, 0, ...ranges.map((r, i) => createDiffAttachment(diff, lines, r, existingIds[i])))
  return attachments
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
