import { lstat, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, isAbsolute, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { FileEntry, FileListing } from "./files-protocol.ts"

export function fileError(message: string, code?: string): Error & { code?: string } {
  return Object.assign(new Error(message), code ? { code } : {})
}

export function text(value: unknown, field: string, empty = false): string {
  if (typeof value !== "string" || (!empty && !value) || value.includes("\0")) throw fileError(`Invalid ${field}`, "invalid")
  return value
}

export function absolutePath(value: unknown): string {
  const path = text(value, "path")
  if (!isAbsolute(path)) throw fileError("File path must be absolute", "invalid")
  return resolve(path)
}

export function whole(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw fileError(`Invalid ${field}`, "invalid")
  return value as number
}

export function uploadPath(value: unknown): string[] {
  const path = text(value, "relative path", true)
  if (!path) return []
  const parts = path.split("/")
  if (parts.some(part => !part || part === "." || part === ".." || /[\\:\0]/u.test(part))) {
    throw fileError("Upload path must stay inside the selected item", "invalid")
  }
  return parts
}

export async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error }
}

export async function directoryPath(value: unknown): Promise<string> {
  const path = absolutePath(value)
  if (!(await stat(path)).isDirectory()) throw fileError("Path is not a directory", "invalid")
  return realpath(path)
}

export async function fileEntry(path: string): Promise<FileEntry> {
  const entry = await lstat(path)
  const info = entry.isSymbolicLink() ? await stat(path) : entry
  if (entry.isSymbolicLink() && info.isDirectory()) throw fileError("Directory symbolic links are not transferred", "unsupported")
  if (!info.isFile() && !info.isDirectory()) throw fileError("Only regular files and directories are supported", "unsupported")
  if (!Number.isSafeInteger(info.size)) throw fileError("File is too large", "unsupported")
  return { name: basename(path), path: await realpath(path), kind: info.isDirectory() ? "directory" : "file", size: info.isFile() ? info.size : 0, modifiedAt: info.mtimeMs }
}

export async function fileRoots(): Promise<FileListing["roots"]> {
  if (process.platform !== "win32") return [{ name: "/", path: "/" }]
  const roots = await Promise.all(Array.from({ length: 26 }, async (_, index) => {
    const name = `${String.fromCharCode(65 + index)}:`
    try { return (await stat(`${name}\\`)).isDirectory() ? { name, path: `${name}\\` } : null }
    catch { return null }
  }))
  return roots.filter((root): root is { name: string; path: string } => root !== null)
}

export async function sessionResourcePath(sessionId: unknown, value: unknown, sessionDirectory?: (sessionId: string) => Promise<string>): Promise<string> {
  const id = text(sessionId, "Session ID")
  if (!sessionDirectory) throw fileError("Session resources are unavailable", "unsupported")
  // Validate the Session even for absolute references; its context belongs to this machine.
  const cwd = await sessionDirectory(id)
  // Strip editor locations before decoding so %23 and %3A remain filename bytes.
  // An absolute Windows drive path keeps its drive colon; only its final location is removed.
  const reference = text(value, "resource URI").split("#", 1)[0]!
  const uri = /^[a-z]:\d+(?::\d+)?$/iu.test(reference) ? reference : reference.replace(/:[1-9]\d*(?::[1-9]\d*)?$/u, "")
  if (/^file:/iu.test(uri)) return absolutePath(fileURLToPath(uri))
  if (!isAbsolute(uri) && /^[a-z][a-z0-9+.-]*:/iu.test(uri)) throw fileError("Only file references are supported", "unsupported")
  let path: string
  try { path = decodeURIComponent(uri) } catch { throw fileError("Invalid resource URI", "invalid") }
  return resolve(absolutePath(cwd), text(path, "resource path"))
}

export const defaultDirectory = homedir
