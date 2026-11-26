import { expect, test } from "vitest"
import {
  isPannablePreview,
  previewKindFromMime,
  previewKindFromUri,
  previewResourceRequestFromQuery,
  previewResourceRequestToQuery,
  resolveAvailableViews,
  resolveInitialView,
  resolvePreviewFormat,
  resolvePreviewKind,
} from "./preview.ts"

test.each([
  ["csv", "text/csv"],
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

test("standalone preview query round-trips the original Team, Machine, Session and file", () => {
  const request = {
    target: { kind: "machine" as const, teamId: "team-origin", machineId: "machine-origin" },
    sessionId: "session-origin",
    uri: "./项目 方案.pptx#L2",
    basePath: "/work/reports/README.md",
  }
  const params = new URLSearchParams({ kind: "pptx", content: request.uri })
  for (const [key, value] of Object.entries(previewResourceRequestToQuery(request))) {
    if (value !== undefined) params.set(key, value)
  }
  const reopened = new URL(`https://example.test/#/preview?${params}`).hash.split("?")[1]
  const parsed = new URLSearchParams(reopened)
  expect(previewResourceRequestFromQuery(key => parsed.get(key))).toEqual(request)
})

test.each([
  { fileTarget: "local", fileGrantId: "window-owned" },
  { fileTarget: "unknown" },
  { fileTarget: "machine", fileTeamId: "team" },
  { fileTarget: "machine", fileTeamId: ["team"], fileMachineId: "machine", fileSessionId: "session", fileUri: "/work/preview.docx" },
  { fileTarget: "machine", fileTeamId: "team", fileMachineId: "machine", fileSessionId: "session", fileUri: "\0/work/preview.docx" },
  { fileTarget: "machine", fileTeamId: "team", fileMachineId: "machine", fileSessionId: "session", fileUri: "./diagram.png", fileBasePath: "\0/work/README.md" },
])("does not restore unsupported or incomplete resource scope from $fileTarget queries", query => {
  expect(previewResourceRequestFromQuery(key => (query as Record<string, unknown>)[key])).toBeUndefined()
})

test("local window grants are never placed in preview URLs", () => {
  const query = previewResourceRequestToQuery({
    target: { kind: "local", grantId: "window-owned" }, sessionId: "session", uri: "/work/preview.docx",
  })
  expect(Object.values(query).every(value => value === undefined)).toBe(true)
  expect(query).not.toHaveProperty("grantId")
})

test("resolves declared switchable formats, view availability, and #L initial views", () => {
  const md = resolvePreviewFormat("README.md", "text/markdown")
  expect(md?.views).toEqual(["source", "markdown"])
  expect(previewKindFromMime("text/markdown")).toBeUndefined()

  const html = resolvePreviewFormat("index.htm", "text/html")
  expect(html?.views).toEqual(["source", "html"])
  expect(previewKindFromMime("text/html")).toBeUndefined()

  const svg = resolvePreviewFormat("logo.svg", "image/svg+xml")
  expect(svg?.views).toEqual(["image", "source"])
  expect(previewKindFromMime("image/svg+xml")).toBe("image")
  expect(resolveAvailableViews(svg, false)).toEqual(["image"])
  expect(resolveInitialView(resolveAvailableViews(svg, true), false)).toBe("image")
  expect(resolveInitialView(resolveAvailableViews(svg, true), true)).toBe("source")

  const csv = resolvePreviewFormat("report.csv", "text/csv")
  expect(csv?.views).toEqual(["csv", "source"])
  expect(resolveInitialView(resolveAvailableViews(csv, true), false)).toBe("csv")
  expect(resolveInitialView(resolveAvailableViews(csv, true), true)).toBe("source")

  const mmd = resolvePreviewFormat("diagram.mmd", "text/plain")
  expect(mmd?.views).toEqual(["mermaid", "source"])
  expect(resolveInitialView(resolveAvailableViews(mmd, true), false)).toBe("mermaid")
  expect(resolveInitialView(resolveAvailableViews(mmd, true), true)).toBe("source")

  const png = resolvePreviewFormat("photo.png", "image/png")
  expect(png?.views).toEqual(["image"])
  expect(resolveInitialView(resolveAvailableViews(png, false), true)).toBe("image")
})
