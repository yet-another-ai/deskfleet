import { afterEach, expect, test, vi } from "vitest"
import { BrowserFilesEndpoint, createBrowserFiles } from "./browser-files.ts"
import type { CentralApi, CentralEvent } from "./central.ts"

afterEach(() => vi.unstubAllGlobals())

test("local browser access starts with an explicit directory grant and cannot escape it", async () => {
  const file = new File(["hello"], "note.txt", { lastModified: 123 })
  const fileHandle = { kind: "file", name: "note.txt", getFile: async () => file }
  const directory = {
    kind: "directory", name: "chosen", isSameEntry: async () => true,
    async *entries() { yield ["note.txt", fileHandle] },
    async getFileHandle(name: string) { if (name !== "note.txt") throw new DOMException("Missing", "NotFoundError"); return fileHandle },
  }
  const choose = vi.fn(async () => directory)
  vi.stubGlobal("window", { showDirectoryPicker: choose })
  const endpoint = new BrowserFilesEndpoint()
  await expect(endpoint.call("list", {})).rejects.toThrow("Choose a local folder")
  const listing = await endpoint.choose()
  expect(choose).toHaveBeenCalledWith({ mode: "readwrite" })
  expect(listing).toMatchObject({ path: "/chosen", parentPath: null, entries: [{ name: "note.txt", size: 5 }] })
  const read = await endpoint.call("read", { path: "/chosen/note.txt", offset: 1, length: 3, modifiedAt: 123 })
  expect(new TextDecoder().decode(read.data)).toBe("ell")
  await expect(endpoint.call("read", { path: "/chosen/note.txt", offset: 0, length: 5, modifiedAt: 122 })).rejects.toThrow("changed")
  await expect(endpoint.call("stat", { path: "/chosen/../secret" })).rejects.toThrow("Invalid")
  await expect(endpoint.call("stat", { path: "/ungranted/file" })).rejects.toThrow("Choose a local folder")
  await endpoint.close()
})

test("unsupported browsers explain the directory-access requirement and cancellation is harmless", async () => {
  vi.stubGlobal("window", {})
  const endpoint = new BrowserFilesEndpoint()
  await expect(endpoint.choose()).rejects.toThrow("directory access support")
  vi.stubGlobal("window", { showDirectoryPicker: async () => { throw new DOMException("Cancelled", "AbortError") } })
  expect(await endpoint.choose()).toBeNull()
  await endpoint.close()
})

test("browser read sessions retain the selected handle, bind its path, and validate changes before release", async () => {
  let file = new File(["hello"], "note.txt", { lastModified: 123 })
  const fileHandle = { kind: "file", name: "note.txt", getFile: async () => file }
  const getFileHandle = vi.fn(async () => fileHandle)
  const directory = { kind: "directory", name: "chosen", isSameEntry: async () => true, async *entries() {}, getFileHandle }
  vi.stubGlobal("window", { showDirectoryPicker: async () => directory })
  const endpoint = new BrowserFilesEndpoint()
  await endpoint.choose()
  const path = "/chosen/note.txt"
  const { readId } = (await endpoint.call("openRead", { path, modifiedAt: 123 })).value
  for (const offset of [0, 1]) {
    expect((await endpoint.call("read", { path, readId, offset, length: 1 })).data).toEqual(new Uint8Array(["hello".charCodeAt(offset)]))
  }
  expect(getFileHandle).toHaveBeenCalledOnce()
  await expect(endpoint.call("read", { path: "/chosen/another.txt", readId, offset: 0, length: 1 })).rejects.toThrow("path")
  file = new File(["world"], "note.txt", { lastModified: 124 })
  await expect(endpoint.call("read", { path, readId, offset: 0, length: 1 })).rejects.toThrow("changed")
  await expect(endpoint.call("closeRead", { readId })).rejects.toThrow("changed")
  await expect(endpoint.call("read", { path, readId, offset: 0, length: 1 })).rejects.toThrow("Unknown file read")
  await endpoint.close()
})

test("account changes and cached-page suspension discard local grants without breaking the wrapper", async () => {
  const directory = { kind: "directory", name: "chosen", isSameEntry: async () => true, async *entries() {} }
  const events = new Map<string, (event: { persisted: boolean }) => void>()
  vi.stubGlobal("window", {
    showDirectoryPicker: async () => directory,
    addEventListener: (name: string, listener: (event: { persisted: boolean }) => void) => events.set(name, listener),
    removeEventListener: (name: string) => events.delete(name),
  })
  let account!: (event: CentralEvent) => void
  const unsubscribe = vi.fn()
  const files = createBrowserFiles({ onEvent(listener: (event: CentralEvent) => void) { account = listener; return unsubscribe } } as unknown as CentralApi)
  await files.chooseLocalDirectory()
  expect((await files.list({ kind: "local" })).path).toBe("/chosen")
  account({ type: "accountChanged" })
  await expect(files.list({ kind: "local" })).rejects.toThrow("Choose a local folder")
  await files.chooseLocalDirectory()
  events.get("pagehide")!({ persisted: true })
  await expect(files.list({ kind: "local" })).rejects.toThrow("Choose a local folder")
  await files.chooseLocalDirectory()
  expect((await files.list({ kind: "local" })).path).toBe("/chosen")
  await files.close()
  expect(unsubscribe).toHaveBeenCalledOnce()
  expect(events.has("pagehide")).toBe(false)
})
