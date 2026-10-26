import type { WebContents, HandlerDetails } from "electron"
import { beforeEach, expect, test, vi } from "vitest"
import { attachExternalLinks } from "./external-links.ts"

const mocks = vi.hoisted(() => ({ openExternal: vi.fn().mockResolvedValue(undefined) }))
vi.mock("electron", () => ({ shell: mocks }))
beforeEach(() => vi.clearAllMocks())

test("explicit external-window requests open HTTP(S) in the system browser while denying renderer windows", () => {
  const contents = { setWindowOpenHandler: vi.fn() }
  attachExternalLinks(contents as unknown as WebContents)
  const handler = contents.setWindowOpenHandler.mock.calls[0]![0] as (details: HandlerDetails) => { action: string }
  expect(mocks.openExternal).not.toHaveBeenCalled()
  for (const url of ["https://example.invalid/continue", "http://localhost:3000/login"]) {
    expect(handler({ url } as HandlerDetails)).toEqual({ action: "deny" })
    expect(mocks.openExternal).toHaveBeenLastCalledWith(url)
  }
  for (const url of ["javascript:alert(1)", "file:///tmp/private", "custom://login", "not a URL"]) expect(handler({ url } as HandlerDetails)).toEqual({ action: "deny" })
  expect(mocks.openExternal).toHaveBeenCalledTimes(2)
})
