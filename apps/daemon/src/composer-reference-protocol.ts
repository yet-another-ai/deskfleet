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

export interface ComposerReferenceResolve {
  /** Resolve only after the receiving Session has captured its directories. */
  sessionId: string
  references: ComposerReference[]
}
