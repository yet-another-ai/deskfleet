import { mount, type VueWrapper } from "@vue/test-utils"
import { createPinia, disposePinia } from "pinia"
import { afterEach, expect, test, vi } from "vitest"
import { defineComponent, h, type HTMLAttributes } from "vue"
import { useSidebarOrder } from "../../composables/useSidebarOrder.ts"
import SidebarReorderRow from "./SidebarReorderRow.vue"

const rows = "[data-sidebar-reorder-id]"
const edge = "data-sidebar-reorder-edge"
const sourceSelector = "[data-sidebar-reorder-source]"
let pinia: ReturnType<typeof createPinia> | undefined
let view: VueWrapper | undefined

afterEach(() => {
  view?.unmount()
  if (pinia) disposePinia(pinia)
  window.localStorage.clear()
})

function mountRows() {
  pinia = createPinia()
  const items = ["first", "hidden", "second"].map(id => ({ id }))
  const others = ["other", "last"].map(id => ({ id }))
  const fixture = defineComponent(() => {
    const { ordered } = useSidebarOrder()
    const renderRows = (group: string, siblings: typeof items) => ordered(group, siblings).map(item => h(SidebarReorderRow, {
      key: item.id, group, items: siblings, id: item.id, hidden: item.id === "hidden",
    }, { default: ({ source }: { source: HTMLAttributes }) => h("a", { ...source, href: `#${item.id}` }, item.id) }))
    return () => h("aside", [...renderRows("local", items), ...renderRows("other", others)])
  })
  view = mount(fixture, { attachTo: document.body, global: { plugins: [pinia] } })
  return view
}

function row(view: VueWrapper, id: string) {
  return view.get<HTMLElement>(`[data-sidebar-reorder-id="${id}"]`)
}

function visibleOrder(view: VueWrapper) {
  return view.findAll(`${rows}:not([hidden])`).map(child => child.attributes("data-sidebar-reorder-id"))
}

test("shows the insert edge and moves a row only within its own group", async () => {
  const view = mountRows()
  const source = row(view, "first").get(sourceSelector)
  const target = row(view, "second")
  const other = row(view, "other")
  vi.spyOn(target.element, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 20))
  const dataTransfer = new DataTransfer()
  vi.spyOn(dataTransfer, "setDragImage").mockImplementation(() => {})
  dataTransfer.setData("text/uri-list", "https://deskfleet.example/#first")

  await source.trigger("dragstart", { dataTransfer })
  expect(source.attributes("draggable")).toBe("true")
  expect(dataTransfer.types).toEqual(["application/x-deskfleet-sidebar-order"])
  await other.trigger("dragover", { dataTransfer })
  expect(other.attributes(edge)).toBeUndefined()
  await other.trigger("drop", { dataTransfer })
  expect(visibleOrder(view)).toEqual(["first", "second", "other", "last"])

  await target.trigger("dragover", { dataTransfer, clientY: 15 })
  expect(target.attributes(edge)).toBe("after")
  await source.trigger("dragend", { dataTransfer })
  expect(target.attributes(edge)).toBeUndefined()

  await source.trigger("dragstart", { dataTransfer })
  await target.trigger("drop", { dataTransfer, clientY: 15 })
  expect(visibleOrder(view)).toEqual(["second", "first", "other", "last"])
  expect(target.attributes(edge)).toBeUndefined()
})

test("uses Alt+arrow to move the focused row to the next visible sibling", async () => {
  const view = mountRows()
  const source = row(view, "first").get<HTMLAnchorElement>(sourceSelector)
  source.element.focus()
  expect(source.attributes("aria-keyshortcuts")).toBe("Alt+ArrowUp Alt+ArrowDown")
  await source.trigger("keydown", { key: "ArrowDown" })
  expect(visibleOrder(view)).toEqual(["first", "second", "other", "last"])
  await source.trigger("keydown", { key: "ArrowDown", altKey: true })
  expect(visibleOrder(view)).toEqual(["second", "first", "other", "last"])
  expect(document.activeElement).toBe(source.element)
})
