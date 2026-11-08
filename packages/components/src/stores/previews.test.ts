import { beforeEach, expect, test, vi } from "vitest"
import { previewResourceRequestToQuery, type PreviewDescriptor } from "../services/preview.ts"
import { focusPreview, focusedPreviewFromRoute } from "./previews.ts"

const state = vi.hoisted(() => ({
  push: vi.fn(),
  route: { value: { path: "/sessions/current", query: {} as Record<string, string | undefined> } },
  layout: { compact: false, sidebarOpen: false, requestSessionWindow: vi.fn() },
}))
vi.mock("../router/index.ts", () => ({ router: { currentRoute: state.route, push: state.push } }))
vi.mock("./layout.ts", () => ({ useLayoutStore: () => state.layout }))

beforeEach(() => {
  vi.clearAllMocks()
  state.route.value.query = {}
})

const item: PreviewDescriptor = {
  kind: "docx",
  content: "/work/项目方案.docx",
  source: { sessionId: "session-origin", entryId: "entry", itemId: "file" },
  resourceRequest: {
    target: { kind: "machine", teamId: "team-origin", machineId: "machine-origin" },
    sessionId: "session-origin",
    uri: "/work/项目方案.docx",
  },
}

test("focus navigation restores the original file request independently of the active Session", async () => {
  await focusPreview(item)
  const navigation = state.push.mock.calls[0]![0]
  const restored = focusedPreviewFromRoute({ params: { sessionId: "current" }, query: navigation.query })
  expect(restored).toMatchObject({ kind: item.kind, content: item.content, resourceRequest: item.resourceRequest })
  expect(restored?.resourceRequest?.sessionId).toBe("session-origin")
})

test("focusing a URL clears any previous file request from the route", async () => {
  state.route.value.query = { ...previewResourceRequestToQuery(item.resourceRequest), unrelated: "retained" }
  await focusPreview({ kind: "image", content: "https://example.test/image.png" })
  const navigation = state.push.mock.calls[0]![0]
  expect(navigation.query.unrelated).toBe("retained")
  expect(focusedPreviewFromRoute({ params: {}, query: navigation.query })?.resourceRequest).toBeUndefined()
  expect(navigation.query.fileTarget).toBeUndefined()
  expect(navigation.query.fileUri).toBeUndefined()
})
