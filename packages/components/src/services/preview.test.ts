import { expect, test } from "vitest"
import { isPannablePreview, previewKindFromMime, previewKindFromUri, resolvePreviewKind } from "./preview.ts"

test.each([
  ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ["pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
] as const)("recognizes %s files and preserves their type for Blob previews", (kind, mimeType) => {
  expect(previewKindFromMime(` ${mimeType.toUpperCase()}; charset=binary `)).toBe(kind)
  expect(previewKindFromUri(`/work/reports/项目方案.${kind.toUpperCase()}?download=1#preview`)).toBe(kind)
  expect(previewKindFromUri(`/work/report.${kind}`, "application/octet-stream")).toBe(kind)
  expect(previewKindFromUri(`data:${mimeType};base64,UEs=`)).toBe(kind)
  expect(resolvePreviewKind(`file:///work/report.${kind}`)).toBe(kind)
  expect(resolvePreviewKind("blob:http://localhost/office", kind)).toBe(kind)
  expect(resolvePreviewKind("blob:http://localhost/office", undefined, mimeType)).toBe(kind)
  expect(isPannablePreview(kind)).toBe(false)
})

test.each([
  ["doc", "application/msword"],
  ["xls", "application/vnd.ms-excel"],
  ["ppt", "application/vnd.ms-powerpoint"],
  ["docm", "application/vnd.ms-word.document.macroEnabled.12"],
  ["xlsm", "application/vnd.ms-excel.sheet.macroEnabled.12"],
  ["pptm", "application/vnd.ms-powerpoint.presentation.macroEnabled.12"],
])("keeps unsupported %s files out of Office previews", (extension, mimeType) => {
  expect(previewKindFromMime(mimeType)).toBeUndefined()
  expect(previewKindFromUri(`/work/report.${extension}`)).toBeUndefined()
})
