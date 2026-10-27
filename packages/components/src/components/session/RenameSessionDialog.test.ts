import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import { i18n } from "../../i18n/index.ts"
import { deferred } from "../../test/desktop-media.ts"
import RenameSessionDialog from "./RenameSessionDialog.vue"

let wrapper: VueWrapper | undefined
afterEach(async () => { wrapper?.unmount(); wrapper = undefined; await flushPromises() })
const content = () => new DOMWrapper(document.querySelector<HTMLElement>('[role="dialog"]')!)

test("rename selects the current title, rejects blank names, and submits a trimmed title", async () => {
  const confirm = vi.fn().mockResolvedValue(undefined)
  wrapper = mount(RenameSessionDialog, {
    attachTo: document.body,
    props: { title: "Investigate failing checks", confirm },
    global: { plugins: [i18n] },
  })
  await flushPromises()
  const dialog = content()
  const input = dialog.get("input")
  await vi.waitFor(() => expect(document.activeElement).toBe(input.element))
  expect(input.element.value).toBe("Investigate failing checks")
  expect(input.element.selectionStart).toBe(0)
  expect(input.element.selectionEnd).toBe(input.element.value.length)
  expect(dialog.get("label").attributes("for")).toBe(input.attributes("id"))
  expect(input.attributes("maxlength")).toBe("200")
  await input.setValue("   ")
  expect(dialog.get('[type="submit"]').attributes("disabled")).toBeDefined()
  await dialog.get("form").trigger("submit")
  expect(confirm).not.toHaveBeenCalled()
  await input.setValue("x".repeat(201))
  await dialog.get("form").trigger("submit")
  expect(confirm).not.toHaveBeenCalled()
  await input.setValue("  Investigate payment errors  ")
  await dialog.get("form").trigger("submit"); await flushPromises()
  expect(confirm).toHaveBeenCalledExactlyOnceWith("Investigate payment errors")
  expect(wrapper.emitted("close")).toEqual([[]])
})

test("rename retains the edited title after a failure and allows correcting and retrying it", async () => {
  const confirm = vi.fn().mockRejectedValueOnce(new Error("Connection lost")).mockResolvedValue(undefined)
  wrapper = mount(RenameSessionDialog, {
    attachTo: document.body,
    props: { title: "Original title", confirm },
    global: { plugins: [i18n] },
  })
  await flushPromises()
  const dialog = content()
  await dialog.get("input").setValue("First edit")
  await dialog.get("form").trigger("submit"); await flushPromises()
  expect(dialog.get('[role="alert"]').text()).toBe("Connection lost")
  expect(dialog.get("input").element.value).toBe("First edit")
  expect(dialog.get("input").attributes("aria-describedby")).toBe(dialog.get('[role="alert"]').attributes("id"))
  expect(wrapper.emitted("close")).toBeUndefined()
  await dialog.get("input").setValue("Corrected title")
  await dialog.get("form").trigger("submit"); await flushPromises()
  expect(confirm.mock.calls).toEqual([["First edit"], ["Corrected title"]])
  expect(wrapper.emitted("close")).toEqual([[]])
})

test("offline and pending rename cannot submit twice or dismiss an in-flight operation", async () => {
  const result = deferred<void>()
  const confirm = vi.fn(() => result.promise)
  wrapper = mount(RenameSessionDialog, {
    attachTo: document.body,
    props: { title: "Original title", disabled: true, confirm },
    global: { plugins: [i18n] },
  })
  await flushPromises()
  const dialog = content()
  await dialog.get("form").trigger("submit")
  expect(confirm).not.toHaveBeenCalled()
  await wrapper.setProps({ disabled: false })
  await dialog.get("form").trigger("submit")
  await dialog.get("form").trigger("submit")
  await dialog.trigger("keydown", { key: "Escape" })
  expect(confirm).toHaveBeenCalledOnce()
  expect(dialog.get("input").attributes("disabled")).toBeDefined()
  expect(dialog.get('[type="submit"]').text()).toBe("Saving…")
  expect(wrapper.emitted("close")).toBeUndefined()
  result.resolve(); await flushPromises()
  expect(wrapper.emitted("close")).toEqual([[]])
})

test("Escape cancels renaming without changing the session", async () => {
  const confirm = vi.fn()
  wrapper = mount(RenameSessionDialog, {
    attachTo: document.body,
    props: { title: "Original title", confirm },
    global: { plugins: [i18n] },
  })
  await flushPromises()
  const dialog = content()
  await dialog.get("input").setValue("Discarded title")
  await dialog.trigger("keydown", { key: "Escape" }); await flushPromises()
  expect(confirm).not.toHaveBeenCalled()
  expect(wrapper.emitted("close")).toEqual([[]])
})
