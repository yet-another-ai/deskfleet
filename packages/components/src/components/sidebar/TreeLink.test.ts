import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import { defineComponent, h, ref } from "vue"
import { createMemoryHistory, createRouter } from "vue-router"
import { accountSessionKey, type AccountSession } from "../../composables/useAccountSession.ts"
import TreeLink from "./TreeLink.vue"

let view: VueWrapper | undefined
afterEach(() => { view?.unmount(); view = undefined })

test("equal Session IDs highlight only their owning Machine and navigate with that Machine", async () => {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: "/sessions/:sessionId", name: "session", component: { render: () => null } }] })
  await router.push("/sessions/30")
  const machineId = ref("a")
  const openMachineRoute = vi.fn()
  const account = { machineId, openMachineRoute } as unknown as AccountSession
  const icon = defineComponent(() => () => h("span"))
  const wrapper = defineComponent(() => () => h("div", ["a", "b"].map(id => h(TreeLink, {
    to: { name: "session", params: { sessionId: "30" } }, machineId: id, icon, label: id, depth: 0,
  }))))
  view = mount(wrapper, { global: { plugins: [router], provide: { [accountSessionKey as symbol]: account } } })
  const links = view.findAll("a")
  expect(links[0]!.classes()).toContain("ui-nav-active")
  expect(links[0]!.attributes("aria-current")).toBe("page")
  expect(links[1]!.classes()).not.toContain("ui-nav-active")
  expect(links[1]!.attributes("aria-current")).toBeUndefined()

  await links[1]!.trigger("click")
  expect(openMachineRoute).toHaveBeenCalledExactlyOnceWith("b", { name: "session", params: { sessionId: "30" } })
  machineId.value = "b"
  await flushPromises()
  expect(links[0]!.classes()).not.toContain("ui-nav-active")
  expect(links[1]!.classes()).toContain("ui-nav-active")

  await links[0]!.trigger("click", { ctrlKey: true })
  expect(openMachineRoute).toHaveBeenCalledTimes(1)
})
