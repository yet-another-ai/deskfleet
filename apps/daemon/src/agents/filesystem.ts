import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, isAbsolute } from "node:path"
import { RequestError, type ReadTextFileRequest, type ReadTextFileResponse, type WriteTextFileRequest, type WriteTextFileResponse } from "@agentclientprotocol/sdk/unstable"

function requireAbsolutePath(path: string): void {
  if (!isAbsolute(path)) throw RequestError.invalidParams({ details: "File path must be absolute" })
}

function readRange(params: ReadTextFileRequest): { start: number; limit?: number } {
  const line = params.line ?? 1
  const limit = params.limit ?? undefined
  if (!Number.isSafeInteger(line) || line < 1) {
    throw RequestError.invalidParams({ details: "File line must be a positive integer" })
  }
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
    throw RequestError.invalidParams({ details: "File line limit must be a nonnegative integer" })
  }
  return { start: line - 1, limit }
}

/** The connection owns session validation; file paths use the daemon user's normal filesystem access. */
export function createAcpFilesystem(requireSession: (sessionId: string) => void) {
  return {
    async readTextFile(params: ReadTextFileRequest, signal?: AbortSignal): Promise<ReadTextFileResponse> {
      requireSession(params.sessionId)
      requireAbsolutePath(params.path)
      const { start, limit } = readRange(params)
      const content = await readFile(params.path, { encoding: "utf8", signal })
      if (start === 0 && limit === undefined) return { content }
      // Keep each line's original terminator, including CRLF and a final newline.
      const lines = content.match(/[^\n]*\n|[^\n]+$/gu) ?? []
      return { content: lines.slice(start, limit === undefined ? undefined : start + limit).join("") }
    },

    async writeTextFile(params: WriteTextFileRequest, signal?: AbortSignal): Promise<WriteTextFileResponse> {
      requireSession(params.sessionId)
      requireAbsolutePath(params.path)
      signal?.throwIfAborted()
      await mkdir(dirname(params.path), { recursive: true })
      await writeFile(params.path, params.content, { encoding: "utf8", signal })
      return {}
    },
  }
}
