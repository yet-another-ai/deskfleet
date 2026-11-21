import { mount } from "@vue/test-utils"
import { createPinia } from "pinia"
import { expect, test } from "vitest"
import AgentOutline from "./AgentOutline.vue"

test("the active row scrolls to the nearest edge of the outline list", async () => {
  const view = mount(AgentOutline, { global: { plugins: [createPinia()] } })
  try {
    const list = view.get("ol").element
    Object.defineProperty(list, "clientHeight", { value: 60 })
    for (const [index, row] of view.findAll("li").entries()) {
      Object.defineProperties(row.element, { offsetTop: { value: index * 10 }, offsetHeight: { value: 10 } })
    }

    await view.setProps({ active: "preview-15" })
    expect(list.scrollTop).toBe(90)
    await view.setProps({ active: "preview-12" })
    expect(list.scrollTop).toBe(90)
    await view.setProps({ active: "preview-4" })
    expect(list.scrollTop).toBe(30)
  } finally {
    view.unmount()
  }
})
