export interface DirectoryEntry {
  name: string
  path: string
  /** Dot-prefixed folders are hidden by default in the picker. */
  hidden: boolean
}

/** All paths belong to the machine serving this request. */
export interface DirectoryListing {
  path: string
  parentPath: string | null
  homePath: string
  roots: Array<{ name: string; path: string }>
  directories: DirectoryEntry[]
}

export interface FilesystemMethods {
  /** Omitting the path opens the daemon user's home directory. */
  directoryList: { params: { path?: string }; result: DirectoryListing }
}
