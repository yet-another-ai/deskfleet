import { afterEach, expect, test, vi } from "vitest"
import { APP_FOREGROUND_EVENT } from "@deskfleet/client/app-foreground"
import { listenForNativeResume } from "./native-resume.ts"

afterEach(() => { vi.unstubAllGlobals() })

test("native resume wakes connection recovery without a page visibility change", async () => {
  const windowTarget = new EventTarget()
  vi.stubGlobal("window", windowTarget)
  const resumed = vi.fn()
  windowTarget.addEventListener(APP_FOREGROUND_EVENT, resumed)
  let resume = () => {}
  await listenForNativeResume(async (_event, listener) => {
    resume = listener
    return { remove: async () => {} }
  })
  resume()
  expect(resumed).toHaveBeenCalledOnce()
})
