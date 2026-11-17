import type { WebContents, HandlerDetails } from "electron"
import { beforeEach, expect, test, vi } from "vitest"
import { attachExternalLinks, isAuxiliaryRendererUrl, parseSessionWindowUrl } from "./external-links.ts"

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

test("allows auxiliary preview and Session windows on the main renderer origin when options are provided", () => {
  const contents = { setWindowOpenHandler: vi.fn() }
  const sessionUrl = "deskfleet-app://bundle/index.html#/sessions/30?window=session&teamId=7&machineId=101"
  expect(parseSessionWindowUrl(sessionUrl)).toEqual({ sessionId: "30", teamId: "7", machineId: "101" })
  expect(parseSessionWindowUrl("deskfleet-app://bundle/index.html#/sessions/archived?window=session")).toBeUndefined()
  expect(isAuxiliaryRendererUrl(sessionUrl)).toBe(true)
  expect(isAuxiliaryRendererUrl("deskfleet-app://bundle/index.html#/sessions/30")).toBe(false)

  const auxiliaryWindowOptions = vi.fn((url: string) =>
    parseSessionWindowUrl(url) ? { width: 1120, height: 780 } : { width: 960, height: 680 },
  )
  attachExternalLinks(contents as unknown as WebContents, auxiliaryWindowOptions)
  const handler = contents.setWindowOpenHandler.mock.calls[0]![0] as (details: HandlerDetails) => { action: string; overrideBrowserWindowOptions?: unknown }
  expect(handler({ url: "http://127.0.0.1:5173/#/mermaid?code=graph%20TD" } as HandlerDetails)).toEqual({
    action: "allow",
    overrideBrowserWindowOptions: { width: 960, height: 680 },
  })
  expect(handler({ url: "deskfleet-app://bundle/index.html#/mermaid?code=graph%20TD" } as HandlerDetails)).toEqual({
    action: "allow",
    overrideBrowserWindowOptions: { width: 960, height: 680 },
  })
  expect(handler({ url: sessionUrl } as HandlerDetails)).toEqual({
    action: "allow",
    overrideBrowserWindowOptions: { width: 1120, height: 780 },
  })

  auxiliaryWindowOptions.mockReturnValueOnce(null as unknown as { width: number; height: number })
  expect(handler({ url: sessionUrl } as HandlerDetails)).toEqual({ action: "deny" })
  expect(mocks.openExternal).not.toHaveBeenCalled()
})
