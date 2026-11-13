import { expect, test, vi } from "vitest"
import { FILE_CHUNK_BYTES, type FileListing } from "../../../apps/daemon/src/files-protocol.ts"
import { CapacitorFilesEndpoint, type FilesBridgePlugin } from "./files.ts"

const documents: FileListing = {
  path: "/Documents", parentPath: null, homePath: "/Documents",
  roots: [{ name: "Documents", path: "/Documents" }], entries: [],
}

function bridge() {
  return {
    filesOpen: vi.fn(async (_options: { id: string }) => {}),
    filesChooseDirectory: vi.fn<FilesBridgePlugin["filesChooseDirectory"]>(async () => ({ value: null })),
    filesCall: vi.fn<FilesBridgePlugin["filesCall"]>(async () => ({ value: documents })),
    filesClose: vi.fn(async (_options: { id: string }) => {}),
  } satisfies FilesBridgePlugin
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

test("native local browsing opens Documents without browser directory access", async () => {
  const plugin = bridge()
  const endpoint = new CapacitorFilesEndpoint(plugin)
  expect(plugin.filesOpen).not.toHaveBeenCalled()
  expect((await endpoint.call("list", {})).value).toEqual(documents)
  expect(await endpoint.choose()).toBeNull()
  const id = plugin.filesOpen.mock.calls[0]![0].id
  expect(plugin.filesCall).toHaveBeenCalledWith({ id, method: "list", params: {} })
  expect(plugin.filesChooseDirectory).toHaveBeenCalledWith({ id })
  await endpoint.close()
  await endpoint.close()
  expect(plugin.filesClose).toHaveBeenCalledExactlyOnceWith({ id })
  await expect(endpoint.call("list", {})).rejects.toThrow("closed")
})

test("binary chunks cross the native bridge without changing bytes, including empty files", async () => {
  const plugin = bridge()
  plugin.filesCall.mockImplementation(async request => ({ value: { bytes: request.data ? atob(request.data).length : 0 }, data: request.data }))
  const endpoint = new CapacitorFilesEndpoint(plugin)
  for (const data of [new Uint8Array(), Uint8Array.from({ length: FILE_CHUNK_BYTES }, (_, index) => index % 256)]) {
    const result = await endpoint.call("write", { transferId: "transfer", path: "", offset: 0 }, data)
    expect(result.value.bytes).toBe(data.length)
    expect(result.data).toEqual(data)
  }
  await expect(endpoint.call("write", { transferId: "transfer", path: "", offset: 0 }, new Uint8Array(FILE_CHUNK_BYTES + 1))).rejects.toThrow("Invalid file write")
  expect(plugin.filesCall).toHaveBeenCalledTimes(2)
  await endpoint.close()
})

test("native errors retain conflict codes for the transfer queue and do not poison later requests", async () => {
  const plugin = bridge()
  plugin.filesCall.mockRejectedValueOnce({ message: "Already exists", code: "conflict" })
  const endpoint = new CapacitorFilesEndpoint(plugin)
  await expect(endpoint.call("begin", { directory: "/Documents", name: "note", kind: "file", conflict: "ask" }))
    .rejects.toMatchObject({ message: "Already exists", code: "conflict" })
  expect((await endpoint.call("list", {})).value).toEqual(documents)
  await endpoint.close()
})

test("bridge requests serialize chunks while abort can interrupt native publication", async () => {
  const plugin = bridge()
  const committing = deferred<{ value: unknown }>()
  plugin.filesCall.mockImplementation(async request => {
    if (request.method === "commit") return committing.promise
    if (request.method === "abort") committing.resolve({ value: { path: "/Documents/note" } })
    return { value: null }
  })
  const endpoint = new CapacitorFilesEndpoint(plugin)
  const commit = endpoint.call("commit", { transferId: "transfer" })
  await vi.waitFor(() => expect(plugin.filesCall).toHaveBeenCalledTimes(1))
  const listing = endpoint.call("list", {})
  expect(plugin.filesCall).toHaveBeenCalledTimes(1)
  await endpoint.call("abort", { transferId: "transfer" })
  await Promise.all([commit, listing])
  expect(plugin.filesCall.mock.calls.map(([request]) => request.method)).toEqual(["commit", "abort", "list"])
  await endpoint.close()
})

test("closing reaches native code during pending work and drops queued requests", async () => {
  const plugin = bridge()
  const pending = deferred<{ value: unknown }>()
  plugin.filesCall.mockReturnValue(pending.promise)
  plugin.filesClose.mockImplementation(async () => { pending.resolve({ value: documents }) })
  const endpoint = new CapacitorFilesEndpoint(plugin)
  const listing = expect(endpoint.call("list", {})).rejects.toThrow("closed")
  await vi.waitFor(() => expect(plugin.filesCall).toHaveBeenCalledTimes(1))
  const queued = expect(endpoint.call("stat", { path: "/Documents/note" })).rejects.toThrow("closed")
  await endpoint.close()
  await Promise.all([listing, queued])
  expect(plugin.filesCall).toHaveBeenCalledTimes(1)
  expect(plugin.filesClose).toHaveBeenCalledOnce()
})

test("closing during native opening releases the eventual endpoint without dispatching queued requests", async () => {
  const plugin = bridge()
  const opening = deferred<void>()
  plugin.filesOpen.mockReturnValue(opening.promise)
  const endpoint = new CapacitorFilesEndpoint(plugin)
  const listing = expect(endpoint.call("list", {})).rejects.toThrow("closed")
  await vi.waitFor(() => expect(plugin.filesOpen).toHaveBeenCalledOnce())
  const queued = expect(endpoint.call("stat", { path: "/Documents/note" })).rejects.toThrow("closed")
  const closing = endpoint.close()
  expect(plugin.filesClose).not.toHaveBeenCalled()

  opening.resolve()
  await Promise.all([closing, endpoint.close(), listing, queued])
  expect(plugin.filesCall).not.toHaveBeenCalled()
  expect(plugin.filesClose).toHaveBeenCalledExactlyOnceWith(plugin.filesOpen.mock.calls[0]![0])
})

test("account endpoints have separate native ownership and unopened endpoints need no cleanup", async () => {
  const plugin = bridge()
  const first = new CapacitorFilesEndpoint(plugin)
  const second = new CapacitorFilesEndpoint(plugin)
  await Promise.all([first.choose(), second.choose()])
  const [firstId, secondId] = plugin.filesOpen.mock.calls.map(([request]) => request.id)
  expect(firstId).not.toBe(secondId)
  await first.close()
  expect(plugin.filesClose).toHaveBeenCalledExactlyOnceWith({ id: firstId })
  expect((await second.call("list", {})).value).toEqual(documents)
  await second.close()
  await new CapacitorFilesEndpoint(plugin).close()
  expect(plugin.filesOpen).toHaveBeenCalledTimes(2)
  expect(plugin.filesClose).toHaveBeenCalledTimes(2)
})

test("closing during a native picker discards its late selection", async () => {
  const plugin = bridge()
  const picked = deferred<{ value: FileListing | null }>()
  plugin.filesChooseDirectory.mockReturnValue(picked.promise)
  const endpoint = new CapacitorFilesEndpoint(plugin)
  const choosing = expect(endpoint.choose()).rejects.toThrow("closed")
  await vi.waitFor(() => expect(plugin.filesChooseDirectory).toHaveBeenCalledOnce())
  await endpoint.close()
  picked.resolve({ value: documents })
  await choosing
})
