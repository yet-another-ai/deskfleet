import { mount } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import { i18n } from "../../i18n/index.ts"
import CopyField from "./CopyField.vue"

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

test("a successful copy is confirmed for two seconds, and another copy restarts that confirmation", async () => {
  vi.useFakeTimers()
  vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue()
  const view = mount(CopyField, { props: { label: "Token", value: "secret" }, global: { plugins: [i18n] } })
  await view.get("button").trigger("click")
  expect(view.get("button").text()).toContain("Copied")
  await vi.advanceTimersByTimeAsync(1_999)
  await view.get("button").trigger("click")
  await vi.advanceTimersByTimeAsync(1_999)
  expect(view.get("button").text()).toContain("Copied")
  await vi.advanceTimersByTimeAsync(1)
  expect(view.get("button").text()).toContain("Copy")
  expect(view.get("button").text()).not.toContain("Copied")
  view.unmount()
})

test("leaving the field clears a pending copy confirmation", async () => {
  vi.useFakeTimers()
  vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue()
  const view = mount(CopyField, { props: { label: "Token", value: "secret" }, global: { plugins: [i18n] } })
  await view.get("button").trigger("click")
  view.unmount()
  await vi.advanceTimersByTimeAsync(2_000)
})
