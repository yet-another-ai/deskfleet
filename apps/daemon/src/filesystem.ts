import { readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import type { DirectoryEntry, DirectoryListing } from "./filesystem-protocol.ts"

async function directoryRoots(): Promise<DirectoryListing["roots"]> {
  if (process.platform !== "win32") return [{ name: "/", path: "/" }]
  const drives = await Promise.all(Array.from({ length: 26 }, async (_, index) => {
    const name = `${String.fromCharCode(65 + index)}:`
    const path = `${name}\\`
    try { return (await stat(path)).isDirectory() ? { name, path } : null }
    catch { return null }
  }))
  return drives.filter((drive): drive is { name: string; path: string } => drive !== null)
}

/** Browse on the owning daemon, regardless of where the requesting UI runs. */
export async function listDirectories(requestedPath = homedir()): Promise<DirectoryListing> {
  if (!isAbsolute(requestedPath)) throw new Error("Directory must use an absolute path")
  const path = resolve(requestedPath)
  const entries = await readdir(path, { withFileTypes: true })
  const directories: DirectoryEntry[] = []
  for (const entry of entries) {
    const entryPath = join(path, entry.name)
    let directory = entry.isDirectory()
    if (entry.isSymbolicLink()) {
      // A dangling or inaccessible link does not prevent browsing its siblings.
      try { directory = (await stat(entryPath)).isDirectory() }
      catch { continue }
    }
    if (directory) directories.push({ name: entry.name, path: entryPath, hidden: entry.name.startsWith(".") })
  }
  directories.sort((left, right) => left.name.localeCompare(right.name, "en"))
  const parent = dirname(path)
  return {
    path,
    parentPath: parent === path ? null : parent,
    homePath: homedir(),
    roots: await directoryRoots(),
    directories,
  }
}
