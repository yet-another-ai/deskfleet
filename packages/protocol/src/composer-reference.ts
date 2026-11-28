export interface ComposerReferenceScope {
  sessionId?: string
  workspaceId?: string
}

export interface ComposerFileReference {
  kind: "file"
  originId: string
  workspaceId: string
  /** Present when selected from an existing Session's captured directories. */
  sessionId?: string
  directoryIndex: number
  /** The directory binding observed when the user selected the reference. */
  sourceDirectory: string
  /** Slash-separated path within the selected directory binding. */
  relativePath: string
}

export interface ComposerSessionReference {
  kind: "session"
  originId: string
  workspaceId: string
  sessionId: string
}

export type ComposerReference = ComposerFileReference | ComposerSessionReference

export interface ComposerReferenceCandidate {
  reference: ComposerReference
  name: string
  description: string
  updatedAt?: string
  archived?: boolean
}

export interface ComposerReferenceSearch extends ComposerReferenceScope {
  kind: ComposerReference["kind"]
  query: string
  limit?: number
}

export interface ComposerReferenceResult {
  items: ComposerReferenceCandidate[]
  truncated: boolean
}

export interface ComposerReferenceResolve extends ComposerReferenceScope {
  /** A workspace lookup supplies front-desk evidence. A Worker resolves again against its captured directories. */
  references: ComposerReference[]
}

export interface ComposerSkillReference { kind: "skill"; id: string; name: string; invocation: string; providerId: string }
export interface ComposerMention {
  id: string
  /** UTF-16 offsets into the textarea value; end is exclusive. */
  start: number
  end: number
  token: string
  reference: ComposerReference | ComposerSkillReference
}

export function validComposerMentions(text: string, mentions: readonly ComposerMention[]): ComposerMention[] {
  let end = 0
  return [...mentions].sort((left, right) => left.start - right.start).filter(mention => {
    if (mention.start < end || mention.start < 0 || mention.end <= mention.start || text.slice(mention.start, mention.end) !== mention.token) return false
    if (mention.start > 0 && !/\s/u.test(text[mention.start - 1]!) || mention.end < text.length && !/\s/u.test(text[mention.end]!)) return false
    end = mention.end
    return true
  })
}

export function composerSkillText(text: string, mentions: readonly ComposerMention[], providerId: string): string {
  let draft = text
  for (const mention of [...mentions].sort((left, right) => right.start - left.start)) {
    const reference = mention.reference
    if (reference.kind !== "skill") continue
    if (reference.providerId !== providerId) throw new Error("Select this skill again for the current Agent")
    if (reference.invocation.startsWith("/") && text.slice(0, mention.start).trim()) {
      throw new Error("This Agent's skill must be placed at the start of the message")
    }
    draft = draft.slice(0, mention.start) + reference.invocation + draft.slice(mention.end)
  }
  return draft
}

/** Canonical github.com issue and pull request URLs are the only actionable links in embedded GitHub snapshots. */
export function isGithubItemUri(uri: string): boolean {
  return uri.trim() === uri && /^https:\/\/github\.com\/(?!\.{1,2}\/)[\w.-]+\/(?!\.{1,2}\/)[\w.-]+\/(?:issues|pull)\/[1-9]\d*$/iu.test(uri)
}
