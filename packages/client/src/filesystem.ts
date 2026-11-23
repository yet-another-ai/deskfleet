import type { DirectoryListing } from "@deskfleet/protocol/filesystem"

export type { DirectoryEntry, DirectoryListing } from "@deskfleet/protocol/filesystem"

/** Browse directories on the connected daemon's machine. Paths stay opaque to the client. */
export interface FilesystemApi {
  listDirectories(path?: string): Promise<DirectoryListing>
}
