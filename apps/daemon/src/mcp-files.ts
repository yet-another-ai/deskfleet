import { FileTransferManager } from "@deskfleet/client/file-transfers"
import type { FileTransfer } from "@deskfleet/client/files"
import { z } from "zod"
import type { RemoteMcpOperation } from "../../../crates/protocol/control.ts"
import type { FileEndpoint, FileMethod, FileMethods, FileReply } from "./files-protocol.ts"
import { fileError } from "./files-paths.ts"
import { FilesService } from "./files-service.ts"

const READ_METHODS = new Set<FileMethod>(["list", "stat", "openRead", "read", "closeRead"])
const WRITE_METHODS = new Set<FileMethod>(["begin", "mkdir", "write", "finish", "commit", "abort"])
const nonEmpty = z.string().refine(v => v.trim().length > 0)

export type RemoteMcpCaller = (operation: RemoteMcpOperation, args: Record<string, unknown>) => Promise<unknown>

/** Serializes file protocol steps over authenticated remote MCP calls so write offsets stay ordered. */
export class RemoteMcpFileEndpoint implements FileEndpoint {
  readonly #remote: RemoteMcpCaller
  #running: Promise<unknown> = Promise.resolve()
  #closed = false

  constructor(remote: RemoteMcpCaller) { this.#remote = remote }

  call<M extends FileMethod>(method: M, params: FileMethods[M]["params"], data?: Uint8Array): Promise<FileReply<FileMethods[M]["result"]>> {
    if (this.#closed) return Promise.reject(fileError("File connection is closed", "closed"))
    const next = this.#running.then(async () => {
      if (this.#closed) throw fileError("File connection is closed", "closed")
      const operation: RemoteMcpOperation = READ_METHODS.has(method) ? "filesRead"
        : WRITE_METHODS.has(method) ? "filesWrite"
          : (() => { throw fileError("Unsupported remote file method", "invalid") })()
      const response = await this.#remote(operation, {
        method, params, ...(data ? { data: Buffer.from(data).toString("base64") } : {}),
      }) as { value: FileMethods[M]["result"]; data?: string }
      return {
        value: response.value,
        ...(typeof response.data === "string" ? { data: new Uint8Array(Buffer.from(response.data, "base64")) } : {}),
      }
    })
    this.#running = next.catch(() => {})
    return next as Promise<FileReply<FileMethods[M]["result"]>>
  }

  async close(): Promise<void> { this.#closed = true; await this.#running }
}

export async function dispatchRemoteFiles(params: Record<string, unknown>, remote: RemoteMcpCaller): Promise<unknown> {
  const { operation, path } = z.strictObject({
    operation: z.enum(["list", "stat"]).default("list"),
    path: nonEmpty.optional(),
  }).parse(params)
  if (operation === "stat" && !path) throw new Error("File path is required")
  const endpoint = new RemoteMcpFileEndpoint(remote)
  try {
    return (await (operation === "stat" ? endpoint.call("stat", { path: path! }) : endpoint.call("list", path ? { path } : {}))).value
  } finally {
    await endpoint.close()
  }
}

export async function dispatchRemoteFileTransfer(
  direction: "upload" | "download", machineId: string, params: Record<string, unknown>, remote: RemoteMcpCaller,
) {
  const { sourcePath, destinationDirectory, conflict } = z.strictObject({
    sourcePath: nonEmpty,
    destinationDirectory: nonEmpty,
    conflict: z.enum(["ask", "replace", "rename", "skip"]).default("ask"),
  }).parse(params)
  const local = new FilesService()
  const remoteEndpoint = new RemoteMcpFileEndpoint(remote)
  const remoteTarget = { kind: "machine" as const, teamId: "mcp", machineId }
  const localTarget = { kind: "local" as const }
  const manager = new FileTransferManager({
    endpoint: async target => target.kind === "local" ? local : remoteEndpoint,
    chooseLocalDirectory: async () => null,
  })
  try {
    const settled = new Promise<FileTransfer>(resolve => {
      const off = manager.onChanged(([job]) => {
        if (job && !["queued", "preparing", "transferring"].includes(job.state)) { off(); resolve(job) }
      })
    })
    await manager.enqueue({
      source: { target: direction === "upload" ? localTarget : remoteTarget, path: sourcePath },
      destination: { target: direction === "upload" ? remoteTarget : localTarget, path: destinationDirectory },
      conflict,
    })
    const job = await settled
    if (job.state !== "completed" && job.state !== "cancelled") throw new Error(job.error ?? "File transfer failed")
    return {
      name: job.name,
      kind: job.kind,
      sourcePath: job.source.path,
      destinationDirectory: job.destination.path,
      transferredBytes: job.transferredBytes,
      totalBytes: job.totalBytes ?? job.transferredBytes,
      skipped: job.state === "cancelled",
    }
  } finally {
    await manager.close()
  }
}
