import { validComposerMentions, type ComposerMention } from "../../../../apps/daemon/src/composer-reference-protocol.ts"
export { validComposerMentions, type ComposerMention, type ComposerSkillReference } from "../../../../apps/daemon/src/composer-reference-protocol.ts"

export interface ComposerTrigger { kind: "reference" | "skill" | "command"; start: number; end: number; query: string }

/** Keep identities through surrounding edits; editing a selected token turns it into plain text. */
export function reconcileComposerMentions(before: string, after: string, mentions: readonly ComposerMention[]): ComposerMention[] {
  if (before === after) return validComposerMentions(after, mentions)
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let oldEnd = before.length, newEnd = after.length
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd-- }
  const delta = newEnd - oldEnd
  return validComposerMentions(after, mentions.flatMap(mention => {
    if (oldEnd <= mention.start) return [{ ...mention, start: mention.start + delta, end: mention.end + delta }]
    if (start >= mention.end) return [mention]
    return []
  }))
}

export function composerTrigger(text: string, caret: number, mentions: readonly ComposerMention[] = []): ComposerTrigger | null {
  if (caret < 0 || caret > text.length || mentions.some(mention => caret > mention.start && caret <= mention.end)) return null
  const prefix = text.slice(0, caret)
  const command = /^\s*\/([^\s/]*)$/u.exec(prefix)
  if (command) return { kind: "command", start: prefix.lastIndexOf("/"), end: caret + /^[^\s/]*/u.exec(text.slice(caret))![0].length, query: command[1]! }
  const match = /(?:^|\s)([@$])([^\s@$]*)$/u.exec(prefix)
  if (!match) return null
  return { kind: match[1] === "@" ? "reference" : "skill", start: caret - match[2]!.length - 1, end: caret + /^[^\s@$]*/u.exec(text.slice(caret))![0].length, query: match[2]! }
}

/** Slash commands are delivered as a new turn, including commands typed without autocomplete. */
export function commandDraft(text: string): boolean { return /^\s*\/\S+/u.test(text) }
