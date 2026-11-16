import { EventEmitter } from "node:events"
import { beforeEach, expect, test, vi } from "vitest"
import { FILES_IPC_CHANNEL, FILES_RESOURCE_PROGRESS_EVENT, type FileAttachmentUploadRequest, type FileAttachmentUploadResult } from "@deskfleet/client/files"

const ipc = vi.hoisted(() => ({ invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }))
vi.mock("electron", () => ({ ipcRenderer: ipc }))
import { filesApi } from "../preload/files.ts"
import { filesBridgeClient } from "./files-bridge.ts"

beforeEach(() => { vi.clearAllMocks() })

const request: FileAttachmentUploadRequest = {
  target: { kind: "machine", teamId: "team", machineId: "machine" },
  draftId: "draft", name: "attachment.json", data: new TextEncoder().encode('{"value":1}'),
}
const uploaded: FileAttachmentUploadResult = {
  path: "/attachments/attachment.json", uri: "file:///attachments/attachment.json", name: request.name, size: request.data.byteLength,
}

function fixture() {
  const events = new EventEmitter()
  const pending = new Map<string, ReturnType<typeof Promise.withResolvers<FileAttachmentUploadResult>>>()
  ipc.on.mockImplementation((name, listener) => { events.on(name, listener); return ipc })
  ipc.removeListener.mockImplementation((name, listener) => { events.removeListener(name, listener); return ipc })
  ipc.invoke.mockImplementation((_channel: string, method: string, args: unknown[]) => {
    if (method === "abortAttachmentUpload") return Promise.resolve()
    expect(method).toBe("uploadAttachment")
    const upload = Promise.withResolvers<FileAttachmentUploadResult>()
    pending.set(args[1] as string, upload)
    return upload.promise
  })
  const bridge = filesApi()
  const upload = vi.spyOn(bridge, "uploadAttachment")
  const api = filesBridgeClient(bridge)
  return {
    api, upload, pending,
    listeners: () => events.listenerCount(FILES_RESOURCE_PROGRESS_EVENT),
    progress: (requestId: string, transferredBytes: number) => events.emit(FILES_RESOURCE_PROGRESS_EVENT, {}, { requestId, transferredBytes, totalBytes: request.data.byteLength }),
  }
}

test("attachment progress crosses the bridge while AbortSignal stays in the renderer", async () => {
  const f = fixture()
  const controller = new AbortController()
  const progress = vi.fn()
  const result = f.api.uploadAttachment!(request, { signal: controller.signal, onProgress: progress })
  const requestId = f.upload.mock.calls[0]![1]
  expect(f.upload).toHaveBeenCalledExactlyOnceWith(request, requestId, progress)
  expect(typeof requestId).toBe("string")
  expect(ipc.invoke).toHaveBeenCalledExactlyOnceWith(FILES_IPC_CHANNEL, "uploadAttachment", [request, requestId])
  f.progress("unrelated", 1)
  expect(progress).not.toHaveBeenCalled()
  f.progress(requestId, request.data.byteLength)
  expect(progress).toHaveBeenCalledExactlyOnceWith({ transferredBytes: request.data.byteLength, totalBytes: request.data.byteLength })
  f.pending.get(requestId)!.resolve(uploaded)
  await expect(result).resolves.toEqual(uploaded)
  expect(f.listeners()).toBe(0)
  controller.abort()
  expect(ipc.invoke).toHaveBeenCalledOnce()
})

test("an already cancelled attachment never starts an IPC upload", async () => {
  const f = fixture()
  const controller = new AbortController()
  const reason = new Error("Attachment removed")
  controller.abort(reason)
  await expect(f.api.uploadAttachment!(request, { signal: controller.signal, onProgress: vi.fn() })).rejects.toBe(reason)
  expect(f.upload).not.toHaveBeenCalled()
  expect(ipc.invoke).not.toHaveBeenCalled()
  expect(f.listeners()).toBe(0)
})

test("cancelling one attachment preserves another upload and cleans up both listeners", async () => {
  const f = fixture()
  const first = new AbortController(), second = new AbortController()
  const firstProgress = vi.fn(), secondProgress = vi.fn()
  const firstResult = f.api.uploadAttachment!(request, { signal: first.signal, onProgress: firstProgress })
  const secondResult = f.api.uploadAttachment!(request, { signal: second.signal, onProgress: secondProgress })
  const firstId = f.upload.mock.calls[0]![1], secondId = f.upload.mock.calls[1]![1]
  expect(firstId).not.toBe(secondId)
  expect(f.listeners()).toBe(2)
  first.abort()
  expect(ipc.invoke).toHaveBeenLastCalledWith(FILES_IPC_CHANNEL, "abortAttachmentUpload", [firstId])
  f.pending.get(firstId)!.reject(new Error("Upload cancelled"))
  await expect(firstResult).rejects.toThrow("Upload cancelled")
  expect(f.listeners()).toBe(1)
  f.progress(firstId, 1)
  f.progress(secondId, request.data.byteLength)
  expect(firstProgress).not.toHaveBeenCalled()
  expect(secondProgress).toHaveBeenCalledOnce()
  f.pending.get(secondId)!.resolve(uploaded)
  await expect(secondResult).resolves.toEqual(uploaded)
  expect(f.listeners()).toBe(0)
  second.abort()
  expect(ipc.invoke.mock.calls.filter(([, method]) => method === "abortAttachmentUpload")).toHaveLength(1)
})

test.each(["synchronous", "asynchronous"])("%s IPC failures reject and release progress and abort listeners", async mode => {
  const f = fixture()
  const controller = new AbortController()
  const reason = new Error("IPC unavailable")
  ipc.invoke.mockImplementationOnce(() => {
    if (mode === "synchronous") throw reason
    return Promise.reject(reason)
  })
  await expect(f.api.uploadAttachment!(request, { signal: controller.signal, onProgress: vi.fn() })).rejects.toBe(reason)
  expect(f.listeners()).toBe(0)
  controller.abort()
  expect(ipc.invoke).toHaveBeenCalledOnce()
})
