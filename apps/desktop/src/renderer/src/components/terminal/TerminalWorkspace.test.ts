import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { afterEach, expect, test, vi } from "vitest"
import type { TerminalSummary } from "../../../../shared/terminal.ts"
import { i18n } from "../../i18n"
import { useTerminalsStore } from "../../stores/terminals.ts"
import TerminalWorkspace from "./TerminalWorkspace.vue"

const first: TerminalSummary = { id: "first", title: "user", cwd: "/home/user", cols: 80, rows: 24, status: "running" }
const second: TerminalSummary = { ...first, id: "second" }

afterEach(() => vi.restoreAllMocks())

function setup(activeId?: string) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const terminals = useTerminalsStore()
  terminals.sessions = [first, second]
  const hangup = vi.spyOn(terminals, "hangup").mockImplementation(async id => {
    terminals.sessions = terminals.sessions.filter(session => session.id !== id)
  })
  const create = vi.fn(async () => {
    const shell = { ...first, id: "third" }
    terminals.sessions.push(shell)
    return shell
  })
  let wrapper: ReturnType<typeof mount<typeof TerminalWorkspace>> | undefined
  wrapper = mount(TerminalWorkspace, {
    props: {
      terminals: terminals.sessions, create, activeId,
      // Mirror v-model so the component sees its own selections; the first fires while mounting.
      "onUpdate:activeId": (id: string | undefined) => { void wrapper?.setProps({ activeId: id }) },
    },
    global: {
      plugins: [pinia, i18n],
      stubs: { LiveTerminal: { name: "LiveTerminal", props: ["terminalId"], emits: ["connection", "title"], template: '<div data-shell :data-id="terminalId" />' } },
    },
  })
  // The parent passes the owner's current list; follow the store as it changes.
  const mounted = wrapper
  const sync = () => mounted.setProps({ terminals: [...terminals.sessions] })
  return { wrapper: mounted, terminals, create, hangup, sync }
}

test("tabs select independent shells without hanging up either and new tab dials another", async () => {
  const { wrapper, create, hangup, sync } = setup("first")
  expect(wrapper.findAll('[role="tab"]').map(tab => tab.text())).toEqual(["Shell 1", "Shell 2"])
  await wrapper.findAll('[role="tab"]')[1]!.trigger("click")
  expect(wrapper.emitted("update:activeId")).toEqual([["second"]])
  expect(wrapper.get("[data-shell]").attributes("data-id")).toBe("second")
  expect(hangup).not.toHaveBeenCalled()
  await wrapper.get('[aria-label="New shell"]').trigger("click")
  await flushPromises()
  await sync()
  expect(create).toHaveBeenCalledOnce()
  expect(wrapper.emitted("update:activeId")?.at(-1)).toEqual(["third"])
  expect(wrapper.findAll('[role="tab"]')).toHaveLength(3)
  wrapper.unmount()
  expect(hangup).not.toHaveBeenCalled()
})

test("hangup removes only that tab and selects its neighbor; final hangup leaves an empty workspace", async () => {
  const { wrapper, terminals, hangup, sync } = setup("first")
  await wrapper.get('[aria-label="Hang up Shell 1"]').trigger("click")
  await flushPromises()
  await sync()
  expect(hangup).toHaveBeenCalledWith("first")
  expect(terminals.sessions.map(({ id }) => id)).toEqual(["second"])
  expect(wrapper.emitted("update:activeId")?.at(-1)).toEqual(["second"])
  await wrapper.get('[aria-label="Hang up Shell 1"]').trigger("click")
  await flushPromises()
  await sync()
  expect(wrapper.emitted("update:activeId")?.at(-1)).toEqual([undefined])
  expect(wrapper.find('[role="tabpanel"]').exists()).toBe(false)
  expect(wrapper.text()).toContain("No open shells")
  wrapper.unmount()
})

test("a hangup from another client removes the active tab and keyboard arrows select remaining tabs", async () => {
  const { wrapper, terminals, hangup, sync } = setup("first")
  await wrapper.findAll('[role="tab"]')[0]!.trigger("keydown", { key: "ArrowRight" })
  expect(wrapper.emitted("update:activeId")?.at(-1)).toEqual(["second"])
  terminals.sessions = [first]
  await sync()
  expect(wrapper.emitted("update:activeId")?.at(-1)).toEqual(["first"])
  expect(hangup).not.toHaveBeenCalled()
  wrapper.unmount()
})

test("with nothing selected the first shell is shown", () => {
  const { wrapper } = setup()
  expect(wrapper.emitted("update:activeId")).toEqual([["first"]])
  wrapper.unmount()
})

test("the active tab shows its connection as an icon, reconnects when broken, and is titled by the running program", async () => {
  const { wrapper, terminals } = setup("first")
  const live = () => wrapper.getComponent({ name: "LiveTerminal" })
  live().vm.$emit("connection", "connected", "Connected")
  await flushPromises()
  const status = () => wrapper.get('[role="status"]')
  expect(status().attributes("data-connection")).toBe("connected")
  expect(status().attributes("aria-label")).toBe("Connected")
  const mounted = live().vm
  await status().trigger("click")
  expect(live().vm).toBe(mounted)
  live().vm.$emit("connection", "disconnected", "Disconnected")
  await flushPromises()
  expect(status().attributes("aria-label")).toBe("Disconnected · Reconnect")
  await status().trigger("click")
  expect(live().vm).not.toBe(mounted)
  live().vm.$emit("title", "htop")
  await flushPromises()
  expect(terminals.titles.first).toBe("htop")
  expect(wrapper.findAll('[role="tab"]').map(tab => tab.text())).toEqual(["htop", "Shell 2"])
  expect(wrapper.text()).not.toMatch(/history|Scrollback/u)
  wrapper.unmount()
})
