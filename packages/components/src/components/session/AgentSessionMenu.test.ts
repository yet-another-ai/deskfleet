import { mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import { i18n } from "../../i18n/index.ts"
import AgentSessionMenu from "./AgentSessionMenu.vue"

let wrapper: VueWrapper | undefined
afterEach(() => { wrapper?.unmount(); wrapper = undefined })

test("a delayed archive dialog close event preserves a reopened restore confirmation", async () => {
  wrapper = mount(AgentSessionMenu, {
    props: { canStop: false, disabled: false, archiveState: "active" },
    global: { plugins: [i18n] },
  })
  const dialog = wrapper.get<HTMLDialogElement>("dialog")
  // Chromium can deliver close after the same native dialog has reopened.
  vi.spyOn(dialog.element, "close").mockImplementationOnce(() => { dialog.element.open = false })
  await wrapper.get('[aria-label="Session actions"]').trigger("click")
  await wrapper.get('[role="menuitem"]').trigger("click")
  await dialog.get(".ui-button-primary").trigger("click")
  expect(wrapper.emitted("archive")).toEqual([[]])

  await wrapper.setProps({ archiveState: "archived" })
  await wrapper.get('[aria-label="Session actions"]').trigger("click")
  await wrapper.get('[role="menuitem"]').trigger("click")
  expect(dialog.element.open).toBe(true)
  await dialog.trigger("close")

  expect(dialog.text()).toContain("Restore this session?")
  expect(dialog.get(".ui-button-primary").text()).toBe("Restore session")
  await dialog.get(".ui-button-primary").trigger("click")
  expect(wrapper.emitted("restore")).toEqual([[]])
  expect(wrapper.emitted("archive")).toEqual([[]])
})
