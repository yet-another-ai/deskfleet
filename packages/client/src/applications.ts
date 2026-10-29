/** Applications installed on the computer running the Electron client. */
export interface LocalApplication {
  id: string
  name: string
  kind: "editor" | "terminal" | "fileManager"
}

export interface OpenWorkspaceRequest {
  applicationId: string
  /** The client's active central registration, not the daemon's catalog ID. */
  machineId: string
  workspaceId?: string
  worktreeId?: string
  /** Omit to open the first (default) Workspace directory. */
  directoryIndex?: number
}

export const APPLICATIONS_CHANNEL = "deskfleet:applications"

/** Client-owned integration; absent in the Web host and never forwarded to a peer. */
export interface LocalApplicationsApi {
  scan(): Promise<LocalApplication[]>
  openWorkspace(request: OpenWorkspaceRequest): Promise<void>
}
