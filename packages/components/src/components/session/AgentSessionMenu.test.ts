import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import { i18n } from "../../i18n/index.ts"
import AgentSessionMenu from "./AgentSessionMenu.vue"

let wrapper: VueWrapper | undefined
afterEach(() => { wrapper?.unmount(); wrapper = undefined })

test("archive and restore confirmations follow the latest session state and return focus to its menu", async () => {
  wrapper = mount(AgentSessionMenu, {
    attachTo: document.body,
    props: { canStop: false, disabled: false, archiveState: "active" },
    global: { plugins: [i18n] },
  })
  const page = new DOMWrapper(document.body)
  await wrapper.get('[aria-label="Session actions"]').trigger("click")
  await flushPromises()
  await page.get('[role="menuitem"]').trigger("click"); await flushPromises()
  expect(page.get('[role="dialog"]').text()).toContain("Archive this session?")
  await page.get('[role="dialog"] .ui-button-primary').trigger("click"); await flushPromises()
  expect(wrapper.emitted("archive")).toEqual([[]])
  expect(page.find('[role="dialog"]').exists()).toBe(false)
  await vi.waitFor(() => expect(document.activeElement).toBe(wrapper!.get('[aria-label="Session actions"]').element))

  await wrapper.setProps({ archiveState: "archived" })
  await wrapper.get('[aria-label="Session actions"]').trigger("click")
  await flushPromises()
  await page.get('[role="menuitem"]').trigger("click"); await flushPromises()

  const dialog = page.get('[role="dialog"]')
  expect(dialog.text()).toContain("Restore this session?")
  expect(dialog.get(".ui-button-primary").text()).toBe("Restore session")
  await dialog.get(".ui-button-primary").trigger("click")
  expect(wrapper.emitted("restore")).toEqual([[]])
  expect(wrapper.emitted("archive")).toEqual([[]])
})

test("keyboard opens the menu, disabled actions stay closed, and Escape cancels a confirmation", async () => {
  wrapper = mount(AgentSessionMenu, {
    attachTo: document.body,
    props: { canStop: true, disabled: true, archiveState: "active" },
    global: { plugins: [i18n] },
  })
  const page = new DOMWrapper(document.body)
  const trigger = wrapper.get('[aria-label="Session actions"]')
  await trigger.trigger("click"); await flushPromises()
  expect(page.find('[role="menu"]').exists()).toBe(false)
  await wrapper.setProps({ disabled: false })
  await trigger.trigger("keydown", { key: "ArrowDown" }); await flushPromises()
  expect(document.activeElement).toBe(page.get('[role="menuitem"]').element)
  await page.get('[role="menuitem"]').trigger("click"); await flushPromises()
  expect(page.get('[role="dialog"]').text()).toContain("Stop this agent?")
  await page.get('[role="dialog"]').trigger("keydown", { key: "Escape" }); await flushPromises()
  expect(page.find('[role="dialog"]').exists()).toBe(false)
  expect(wrapper.emitted("stop")).toBeUndefined()
})
