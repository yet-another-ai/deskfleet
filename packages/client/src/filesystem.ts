import type { DirectoryListing } from "../../../apps/daemon/src/filesystem-protocol.ts"

export type { DirectoryEntry, DirectoryListing } from "../../../apps/daemon/src/filesystem-protocol.ts"

/** Browse directories on the connected daemon's machine. Paths stay opaque to the client. */
export interface FilesystemApi {
  listDirectories(path?: string): Promise<DirectoryListing>
}
