import type { DirectoryListing } from "../../../daemon/src/filesystem-protocol.ts"

export type { DirectoryEntry, DirectoryListing } from "../../../daemon/src/filesystem-protocol.ts"

/** Browse directories on the connected daemon's machine. Paths stay opaque to the client. */
export interface FilesystemApi {
  listDirectories(path?: string): Promise<DirectoryListing>
}
