import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { afterEach, expect, test, vi } from "vitest"
import { spawnDesktopViewer } from "./native-desktop-process.ts"

vi.mock("node:child_process", () => ({ spawn: vi.fn() }))

const children: EventEmitter[] = []
afterEach(() => {
  for (const child of children.splice(0)) child.emit("close", 0, null)
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function fixture(platform: NodeJS.Platform) {
  const env = { ...process.env, DESKFLEET_VIEWER_DECODER: "diagnostic", GPUI_VIEW_RETENTION: "1" }
  vi.stubGlobal("process", { ...process, platform, env })
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
  })
  children.push(child)
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>)
  const receive = vi.fn()
  const viewer = spawnDesktopViewer("/bundled/deskfleet-viewer", receive)
  const options = vi.mocked(spawn).mock.calls[0]![2]!
  return { child, env, receive, viewer, options }
}

test("Windows launches a visible viewer with accessibility replay disabled only in its environment", () => {
  const { options, env } = fixture("win32")
  expect(spawn).toHaveBeenCalledExactlyOnceWith("/bundled/deskfleet-viewer", [], expect.any(Object))
  expect(options.windowsHide).not.toBe(true)
  expect(options.env).toEqual({ ...env, GPUI_VIEW_RETENTION: "0" })
  expect(options.env).not.toBe(env)
  expect(process.env.GPUI_VIEW_RETENTION).toBe("1")
})

test.each(["darwin", "linux"] as const)("%s preserves the viewer environment", platform => {
  const { options, env } = fixture(platform)
  expect(options.env).toEqual(env)
  expect(options.env?.GPUI_VIEW_RETENTION).toBe("1")
})

test("GUI launch preserves private command, event, and diagnostic pipes", () => {
  const { child, options, receive, viewer } = fixture("win32")
  expect(options.stdio).toEqual(["pipe", "pipe", "pipe"])
  viewer.send({ type: "stop" })
  expect(child.stdin.read().toString()).toBe('{"type":"stop"}\n')
  child.stdout.write('{"type":"capabilities","codecs":["h264"]}\n')
  expect(receive).toHaveBeenCalledWith({ type: "capabilities", codecs: ["h264"] })
  child.stderr.write("accessibility tree update failed")
  child.emit("close", 3221226505, null)
  expect(receive).toHaveBeenCalledWith({
    type: "error", error: "Native desktop exited (3221226505): accessibility tree update failed",
  })
})
