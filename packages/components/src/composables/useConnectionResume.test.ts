import { effectScope } from "vue"
import { afterEach, expect, test, vi } from "vitest"
import { useConnectionResume } from "./useConnectionResume.ts"

afterEach(() => { vi.restoreAllMocks() })

test("resumes on visible pages and network recovery only", () => {
  const resume = vi.fn()
  const scope = effectScope()
  scope.run(() => useConnectionResume(resume))
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
  document.dispatchEvent(new Event("visibilitychange"))
  expect(resume).not.toHaveBeenCalled()
  visibility.mockReturnValue("visible")
  document.dispatchEvent(new Event("visibilitychange"))
  window.dispatchEvent(new Event("online"))
  window.dispatchEvent(new Event("pageshow"))
  expect(resume).toHaveBeenCalledTimes(3)
  scope.stop()
  window.dispatchEvent(new Event("online"))
  expect(resume).toHaveBeenCalledTimes(3)
})
