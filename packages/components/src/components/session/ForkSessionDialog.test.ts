import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import { i18n } from "../../i18n/index.ts"
import { deferred } from "../../test/desktop-media.ts"
import ForkSessionDialog from "./ForkSessionDialog.vue"

let wrapper: VueWrapper | undefined
afterEach(async () => { wrapper?.unmount(); wrapper = undefined; await flushPromises() })
const content = () => new DOMWrapper(document.querySelector<HTMLElement>('[role="dialog"]')!)

test("fork context defaults to its source and stays fixed while resolving a pending operation", async () => {
  const confirm = vi.fn().mockRejectedValueOnce(new Error("Connection lost")).mockResolvedValue(undefined)
  wrapper = mount(ForkSessionDialog, {
    attachTo: document.body,
    props: { context: "directory", disabled: false, retrying: false, confirm },
    global: { plugins: [i18n] },
  })
  await flushPromises()
  const dialog = content()
  expect(dialog.get('[role="radio"][value="directory"]').attributes("aria-checked")).toBe("true")
  await dialog.get('[role="radio"][value="worktree"]').trigger("click")
  await dialog.get(".ui-button-primary").trigger("click")
  await flushPromises()
  expect(confirm).toHaveBeenCalledExactlyOnceWith("worktree")
  expect(dialog.get('[role="alert"]').text()).toBe("Connection lost")
  expect(wrapper.emitted("close")).toBeUndefined()
  await wrapper.setProps({ retrying: true })
  expect(dialog.findAll('[role="radio"]').every(radio => radio.attributes("disabled") !== undefined)).toBe(true)
  expect(dialog.get(".ui-button-primary").text()).toBe("Check result")
  await dialog.get(".ui-button-primary").trigger("click")
  await flushPromises()
  expect(confirm).toHaveBeenLastCalledWith("worktree")
  expect(wrapper.emitted("close")).toEqual([[]])
})

test("fork submission prevents duplicate clicks and dismissal until the result arrives", async () => {
  const result = deferred<void>()
  const confirm = vi.fn(() => result.promise)
  wrapper = mount(ForkSessionDialog, {
    attachTo: document.body,
    props: { context: "worktree", disabled: true, retrying: false, confirm },
    global: { plugins: [i18n] },
  })
  await flushPromises()
  const dialog = content()
  await dialog.get(".ui-button-primary").trigger("click")
  expect(confirm).not.toHaveBeenCalled()
  await wrapper.setProps({ disabled: false })
  await dialog.get(".ui-button-primary").trigger("click")
  await dialog.get(".ui-button-primary").trigger("click")
  await dialog.trigger("keydown", { key: "Escape" })
  expect(confirm).toHaveBeenCalledOnce()
  expect(wrapper.emitted("close")).toBeUndefined()
  expect(dialog.get('[role="status"]').text()).toBe("Forking session…")
  result.resolve()
  await flushPromises()
  expect(wrapper.emitted("close")).toEqual([[]])
})

test("machine-scoped Sessions only offer directory fork context", async () => {
  const confirm = vi.fn().mockResolvedValue(undefined)
  wrapper = mount(ForkSessionDialog, {
    attachTo: document.body,
    props: { context: "worktree", allowWorktree: false, disabled: false, retrying: false, confirm },
    global: { plugins: [i18n] },
  })
  await flushPromises()
  const dialog = content()
  expect(dialog.find('[role="radio"][value="worktree"]').exists()).toBe(false)
  expect(dialog.get('[role="radio"][value="directory"]').attributes("aria-checked")).toBe("true")
  await dialog.get(".ui-button-primary").trigger("click")
  await flushPromises()
  expect(confirm).toHaveBeenCalledExactlyOnceWith("directory")
})
