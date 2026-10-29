export const UPDATES_CHANNEL = "deskfleet:updates"
export const UPDATES_CHANGED_EVENT = "deskfleet:updates-changed"

export interface UpdateState {
  status: "disabled" | "idle" | "checking" | "available" | "downloading" | "downloaded" | "installing" | "error"
  currentVersion?: string
  version?: string
  percent?: number
  error?: string
}

/** Updates belong to the local Electron client, independently of the selected Machine. */
export interface UpdateApi {
  get(): Promise<UpdateState>
  /** Check for a newer version without downloading or installing it. */
  check(): Promise<UpdateState>
  /** Download, stop the hosted services, and restart into the update after an explicit click. */
  install(): Promise<void>
  onChanged(listener: (state: UpdateState) => void): () => void
}
