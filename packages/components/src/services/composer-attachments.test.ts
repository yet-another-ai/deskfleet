import { expect, test, vi } from "vitest"
import { MAX_GENERATED_TITLE_LENGTH } from "../../../../apps/daemon/src/titles.ts"
import type { FilesApi, FileTarget } from "../../../client/src/files.ts"
import { cancelAttachmentUpload, getAttachmentUploadState, hasIncompleteAttachmentUploads, retryAttachmentUpload, sessionTitleFromDraft, syncAttachmentUploads, type ComposerAttachment } from "./composer-attachments.ts"

const pasted = (text: string): ComposerAttachment => ({
  id: "paste-1", kind: "pasted_text", text, lines: text.split(/\r\n|\r|\n/u).length,
})

test("short first-line drafts become the Session title unchanged", () => {
  expect(sessionTitleFromDraft("Fix flaky tests", [])).toBe("Fix flaky tests")
})

test("long first-message titles are truncated to the generated-title max", () => {
  const long = "Please investigate why the payment webhook retries forever and dumps a huge stack"
  expect(sessionTitleFromDraft(long, [])).toBe(long.slice(0, MAX_GENERATED_TITLE_LENGTH))
})

test("only the first line of a multi-line draft is used before truncation", () => {
  const first = "x".repeat(MAX_GENERATED_TITLE_LENGTH + 10)
  expect(sessionTitleFromDraft(`${first}\nsecond line`, [])).toBe(first.slice(0, MAX_GENERATED_TITLE_LENGTH))
})

test("empty draft falls back to the first pasted-text line", () => {
  expect(sessionTitleFromDraft("  ", [pasted("  Pasted investigation\nmore")])).toBe("Pasted investigation")
})

test("empty draft with no pasted text uses Session", () => {
  expect(sessionTitleFromDraft("", [])).toBe("Session")
  expect(sessionTitleFromDraft(" \t ", [{ id: "img", kind: "image", name: "a.png", mimeType: "image/png", data: "AA", size: 1 }])).toBe("Session")
})

test("whitespace-only pasted text is ignored for the title", () => {
  expect(sessionTitleFromDraft("", [pasted("   \n\t  ")])).toBe("Session")
})

test("multi-byte first lines truncate with the shared helper", () => {
  const text = "日本語のタイトルを十分に長くして切り詰めを確認する文章です"
  expect(sessionTitleFromDraft(text, [])).toBe(text.slice(0, MAX_GENERATED_TITLE_LENGTH))
})

test("synchronous upload startup failures become retryable instead of remaining uploading", async () => {
  const bytes = new TextEncoder().encode('{"attachment":true}')
  const item: Extract<ComposerAttachment, { kind: "local_file" }> = {
    id: "sync-upload-error", kind: "local_file", name: "data.json", mimeType: "application/json", size: bytes.byteLength, bytes,
  }
  const target: FileTarget = { kind: "local" }
  const failure = new TypeError("options.signal?.throwIfAborted is not a function")
  const uploadAttachment = vi.fn<NonNullable<FilesApi["uploadAttachment"]>>()
    .mockImplementationOnce(() => { throw failure })
    .mockResolvedValueOnce({ path: "/attachments/data.json", uri: "file:///attachments/data.json", name: item.name, size: item.size })
  const filesApi = { uploadAttachment } as unknown as FilesApi

  try {
    expect(() => syncAttachmentUploads({ attachments: [item], target, filesApi })).not.toThrow()
    expect(getAttachmentUploadState(item, target)).toMatchObject({ status: "error", error: failure.message, progress: 0 })
    expect(hasIncompleteAttachmentUploads([item], target)).toBe(true)

    syncAttachmentUploads({ attachments: [item], target, filesApi })
    expect(uploadAttachment).toHaveBeenCalledTimes(1)

    retryAttachmentUpload({ item, target, filesApi })
    await vi.waitFor(() => expect(getAttachmentUploadState(item, target)?.status).toBe("uploaded"))
    expect(uploadAttachment).toHaveBeenCalledTimes(2)
    expect(item.uploadedUri).toBe("file:///attachments/data.json")
    expect(hasIncompleteAttachmentUploads([item], target)).toBe(false)
  } finally {
    cancelAttachmentUpload(item.id)
  }
})
