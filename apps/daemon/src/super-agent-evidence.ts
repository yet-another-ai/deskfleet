import { constants } from "node:fs"
import { open, opendir, realpath, stat } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { TextDecoder } from "node:util"
import { isSubagentNotification } from "../../../packages/client/src/agent-session-scope.ts"
import type { AgentEvent } from "./agent-protocol.ts"

export type SuperEvidenceRequest =
  | { kind: "read" | "list" | "search"; workspaceId: string; rootIndex: number; path?: string; query?: string; line?: number }
  | { kind: "history"; sessionId: string; afterSeq?: string }
  | { kind: "ticket"; ticketId: string }

export interface SuperEvidenceSources {
  /** Resolve from the authenticated registration's current catalog on every call. */
  listRoots: (workspaceId: string) => Promise<string[]>
  readHistory?: (sessionId: string, afterSeq?: string) => Promise<string>
  readTicket?: (ticketId: string) => Promise<string>
}

const maxBytes = 256 * 1024
const maxExcerpt = 12_000
const ignoredDirectories = new Set([".git", "node_modules", "target", ".pnpm-store", ".next", "dist", "build"])
const contains = (root: string, path: string) => {
  const name = relative(root, path)
  return !isAbsolute(name) && name !== ".." && !name.startsWith(`..${sep}`)
}

async function inside(root: string, name: string): Promise<string> {
  if (name.includes("\0") || isAbsolute(name) || name.split(/[\\/]/u).includes("..")) throw new Error("A workspace-relative path is required")
  const path = await realpath(resolve(root, name))
  if (!contains(root, path)) throw new Error("The path is outside this workspace directory")
  return path
}

/** Open the same regular file that passed scope validation, including if its parents move. */
export async function openWorkspaceFile(root: string, name: string) {
  const path = await inside(root, name)
  const known = await stat(path)
  if (!known.isFile()) throw new Error("Not a regular text file")
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const actual = await file.stat()
    if (!actual.isFile() || actual.dev !== known.dev || actual.ino !== known.ino || await inside(root, name) !== path) {
      throw new Error("The file changed while opening it")
    }
    return { file, size: actual.size }
  } catch (error) { await file.close(); throw error }
}

async function textFile(root: string, name: string, byteLimit = maxBytes): Promise<{ text: string; truncated: boolean }> {
  const { file, size } = await openWorkspaceFile(root, name)
  try {
    const buffer = Buffer.alloc(Math.min(size, byteLimit))
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    const bytes = buffer.subarray(0, bytesRead)
    if (bytes.includes(0)) throw new Error("Binary files cannot be used as text evidence")
    const truncated = size > bytesRead
    // A bounded UTF-8 read can end within a multibyte character.
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: truncated }), truncated }
  } finally { await file.close() }
}

async function directoryEvidence(root: string, name: string, term?: string): Promise<string> {
  const directory = await inside(root, name)
  if (!(await stat(directory)).isDirectory()) throw new Error("Not a workspace directory")
  const queue = [relative(root, directory)]
  const rows: string[] = []
  const query = term?.toLocaleLowerCase()
  let seen = 0, fileReads = 0
  while (queue.length && seen < 3000 && rows.length < 80) {
    const dir = queue.shift()!
    const entries = await opendir(await inside(root, dir))
    for await (const entry of entries) {
      if (++seen > 3000 || rows.length >= 80) break
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (!query) rows.push(`${path}/`)
        else if (!ignoredDirectories.has(entry.name)) {
          queue.push(path)
          if (path.toLocaleLowerCase().includes(query)) rows.push(`${path}/`)
        }
        continue
      }
      if (!entry.isFile()) continue
      if (!query || path.toLocaleLowerCase().includes(query)) { rows.push(path); continue }
      if (fileReads++ >= 160) continue
      try {
        const { text } = await textFile(root, path)
        const lines = text.split("\n")
        const index = lines.findIndex(line => line.toLocaleLowerCase().includes(query))
        if (index >= 0) rows.push(`${path}:${index + 1}: ${lines[index]!.slice(0, 240)}`)
      } catch { /* Skip inaccessible, changing and binary files during search. */ }
    }
    if (!query) break
  }
  const page = { path: name || ".", entries: rows, limited: rows.length >= 80 || seen >= 3000 || fileReads > 160 }
  while (JSON.stringify(page).length > maxExcerpt && rows.length) { rows.pop(); page.limited = true }
  return JSON.stringify(page)
}

/** Only directory IDs and relative paths are exposed to the coordinator. No provider or shell is involved. */
export function createSuperEvidence(sources: SuperEvidenceSources): (request: SuperEvidenceRequest) => Promise<string> {
  return async request => {
    if (request.kind === "history") {
      if (!sources.readHistory) throw new Error("Session history is unavailable")
      return (await sources.readHistory(request.sessionId, request.afterSeq)).slice(0, maxExcerpt)
    }
    if (request.kind === "ticket") {
      if (!sources.readTicket) throw new Error("Ticket information is unavailable")
      return (await sources.readTicket(request.ticketId)).slice(0, maxExcerpt)
    }
    const roots = await sources.listRoots(request.workspaceId)
    if (!Number.isSafeInteger(request.rootIndex) || request.rootIndex < 0 || !roots[request.rootIndex]) throw new Error("Unknown workspace directory")
    const root = await realpath(roots[request.rootIndex]!)
    const name = request.path ?? "."
    if (request.kind === "list") return directoryEvidence(root, name)
    if (request.kind === "search") {
      const query = request.query?.trim()
      if (!query || query.length > 256) throw new Error("A short nonempty search phrase is required")
      return directoryEvidence(root, name, query)
    }
    const first = request.line ?? 1
    if (!Number.isSafeInteger(first) || first < 1) throw new Error("Invalid line number")
    const source = await textFile(root, name, first > 1 ? 8 * 1024 * 1024 : maxBytes)
    const lines = source.text.split(/\r?\n/u)
    if (source.truncated && first > lines.length) throw new Error("The requested line is beyond the bounded file scan")
    const excerpt = lines.slice(first - 1, first + 99).join("\n")
    const page = { workspaceId: request.workspaceId, rootIndex: request.rootIndex, path: name, firstLine: first,
      text: excerpt.slice(0, maxExcerpt), truncated: source.truncated || lines.length >= first + 100 || excerpt.length > maxExcerpt }
    while (JSON.stringify(page).length > maxExcerpt && page.text.length) { page.text = page.text.slice(0, Math.floor(page.text.length * 0.8)); page.truncated = true }
    return JSON.stringify(page)
  }
}

/** Project only public conversational content. Diagnostic payloads, shell commands, approvals and reasoning stay in the journal. */
export function superHistoryExcerpt(events: readonly AgentEvent[]): string {
  const rows: { seq: string; endSeq: string; role: string; text: string; turnId?: string }[] = []
  const seenInputs = new Set<string>()
  for (const event of events) {
    if (event.kind === "input" && "content" in event.payload && Array.isArray(event.payload.content)) {
      const text = event.payload.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n")
      const id = event.inputId ?? event.payload.id ?? event.seq
      if (text && !seenInputs.has(id)) rows.push({ seq: event.seq, endSeq: event.seq, role: "user", text })
      seenInputs.add(id)
    }
    if (event.kind === "acp" && "update" in event.payload) {
      if (isSubagentNotification(event.payload)) continue
      const update = event.payload.update
      if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text") continue
      const last = rows.at(-1)
      if (last?.role === "assistant" && last.turnId === event.turnId) { last.text += update.content.text; last.endSeq = event.seq }
      else rows.push({ seq: event.seq, endSeq: event.seq, role: "assistant", text: update.content.text, turnId: event.turnId })
    }
  }
  const page = { nextAfterSeq: events.at(-1)?.seq, messages: [] as typeof rows, truncated: false }
  for (const row of rows) {
    const next = { ...row, text: row.text.slice(0, 1800) }
    page.messages.push(next)
    if (JSON.stringify(page).length > maxExcerpt) {
      page.messages.pop()
      page.nextAfterSeq = page.messages.at(-1)?.endSeq
      page.truncated = true
      break
    }
  }
  return JSON.stringify(page)
}
