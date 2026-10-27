import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { afterEach, expect, test, vi } from "vitest"
import type { TerminalSummary } from "../../../../client/src/terminal.ts"
import { i18n } from "../../i18n/index.ts"
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
    attachTo: document.body,
    props: {
      terminals: terminals.sessions, create, activeId,
      // Mirror v-model so the component sees its own selections; the first fires while mounting.
      "onUpdate:activeId": (id: string | undefined) => { void wrapper?.setProps({ activeId: id }) },
    },
    global: {
      plugins: [pinia, i18n],
      stubs: { LiveTerminal: { name: "LiveTerminal", props: ["terminalId", "readOnly"], emits: ["connection", "title"], template: '<div data-shell :data-id="terminalId" />' } },
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
  await wrapper.findAll('[role="tab"]')[1]!.trigger("mousedown", { button: 0 })
  expect(wrapper.emitted("update:activeId")).toEqual([["second"]])
  expect(wrapper.get("[data-shell]").attributes("data-id")).toBe("second")
  expect(wrapper.findAll('[role="tab"]')[1]!.attributes("aria-controls")).toBe(wrapper.get('[role="tabpanel"]').attributes("id"))
  expect(wrapper.findAll('[role="tab"]')[0]!.attributes("aria-controls")).toBeUndefined()
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
  ;(wrapper.findAll('[role="tab"]')[0]!.element as HTMLElement).focus(); await flushPromises()
  await wrapper.findAll('[role="tab"]')[0]!.trigger("keydown", { key: "ArrowRight" }); await flushPromises()
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

test("archived shells can be selected and replayed but cannot create or hang up", async () => {
  const { wrapper, create, hangup } = setup("first")
  await wrapper.setProps({ readOnly: true })
  await wrapper.get('[aria-label="New shell"]').trigger("click")
  await wrapper.get('[aria-label="Hang up Shell 1"]').trigger("click")
  await wrapper.findAll('[role="tab"]')[0]!.trigger("keydown", { key: "Delete" })
  await wrapper.findAll('[role="tab"]')[1]!.trigger("mousedown", { button: 0 })
  expect(wrapper.get("[data-shell]").attributes("data-id")).toBe("second")
  expect(create).not.toHaveBeenCalled()
  expect(hangup).not.toHaveBeenCalled()
  wrapper.unmount()
})

test("an empty archived context never creates a terminal on mount", async () => {
  const pinia = createPinia()
  const ensure = vi.fn(async () => ({ id: "new" }))
  const wrapper = mount(TerminalWorkspace, {
    attachTo: document.body, props: { terminals: [], readOnly: true, create: ensure, ensureTerminal: ensure }, global: { plugins: [pinia, i18n] } })
  await flushPromises()
  expect(ensure).not.toHaveBeenCalled()
  wrapper.unmount()
})

test("agent terminal tabs are visibly read only and expose neither hangup nor Delete", async () => {
  const { wrapper, terminals, hangup, sync } = setup("first")
  terminals.sessions = [{ ...first, kind: "acp" }, second]
  await sync()
  const tab = wrapper.get('[data-terminal-id="first"]')
  expect(tab.text()).toBe("Agent terminalRead only")
  expect(wrapper.getComponent({ name: "LiveTerminal" }).props("readOnly")).toBe(true)
  expect(wrapper.find('[aria-label="Hang up Agent terminal"]').exists()).toBe(false)
  await tab.trigger("keydown", { key: "Delete" })
  expect(hangup).not.toHaveBeenCalled()
  await wrapper.get('[data-terminal-id="second"]').trigger("mousedown", { button: 0 })
  expect(wrapper.getComponent({ name: "LiveTerminal" }).props("readOnly")).toBe(false)
  expect(wrapper.find('[aria-label="Hang up Shell 2"]').exists()).toBe(true)
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
