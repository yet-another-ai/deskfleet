import { mount } from "@vue/test-utils"
import { expect, test, vi } from "vitest"
import { Plus } from "@lucide/vue"
import { i18n } from "../../i18n/index.ts"
import UiButton from "./UiButton.vue"
import IconButton from "./IconButton.vue"

test("buttons opt into form submission and block actions while loading", async () => {
  const click = vi.fn()
  const view = mount(UiButton, { props: { onClick: click }, slots: { default: "Save" } })
  expect(view.get("button").attributes("type")).toBe("button")
  await view.get("button").trigger("click")
  expect(click).toHaveBeenCalledOnce()
  await view.setProps({ loading: true, type: "submit" })
  expect(view.get("button").attributes("type")).toBe("submit")
  expect(view.get("button").attributes("aria-busy")).toBe("true")
  expect(view.get<HTMLButtonElement>("button").element.disabled).toBe(true)
  await view.get("button").trigger("click")
  expect(click).toHaveBeenCalledOnce()
  expect(view.text()).toBe("Save")
  view.unmount()
})

test("icon buttons keep labels and refuse disabled and placeholder actions", async () => {
  const click = vi.fn()
  const view = mount(IconButton, {
    props: { icon: Plus, label: "Add", onClick: click },
    attrs: { "data-action": "add", "aria-expanded": "false" },
    global: { plugins: [i18n] },
  })
  expect(view.get("button").attributes("aria-label")).toBe("Add")
  expect(view.get("button").attributes("data-action")).toBe("add")
  expect(view.get("button").attributes("aria-expanded")).toBe("false")
  await view.get("button").trigger("click")
  expect(click).toHaveBeenCalledOnce()
  await view.setProps({ disabled: true })
  await view.get("button").trigger("click")
  expect(view.get("button").attributes("aria-disabled")).toBe("true")
  expect(click).toHaveBeenCalledOnce()
  await view.setProps({ disabled: false, placeholder: true })
  await view.get("button").trigger("click")
  expect(view.get("button").attributes("aria-label")).toContain("Add")
  expect(click).toHaveBeenCalledOnce()
  view.unmount()
})
