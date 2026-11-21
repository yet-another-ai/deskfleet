import { afterEach, expect, test } from "vitest"
import { effectScope, nextTick, ref } from "vue"
import { createSidebarOrder, machineOrderGroup, sessionOrderGroup, workspaceOrderGroup } from "./useSidebarOrder.ts"

const items = ["a", "b", "c", "d"].map(id => ({ id }))
const ids = (rows: readonly { id: string }[]) => rows.map(row => row.id)

afterEach(() => localStorage.clear())

test("keeps the default order until moved and preserves filtered or unavailable siblings across reload", async () => {
  const scope = effectScope()
  try {
    const order = scope.run(() => createSidebarOrder("test-team"))!
    const group = sessionOrderGroup("machine", "workspace")
    expect(ids(order.ordered(group, items))).toEqual(["a", "b", "c", "d"])
    expect(order.move(group, items, "d", "b", "before")).toBe(true)
    expect(order.move(group, items.filter(item => item.id !== "b"), "c", "a", "before")).toBe(true)
    expect(order.move(group, items, "d", "b", "before")).toBe(false)
    expect(order.move(group, items, "d", "missing", "before")).toBe(false)

    await nextTick()
    const reloaded = scope.run(() => createSidebarOrder("test-team"))!
    expect(ids(reloaded.ordered(group, [{ id: "new" }, ...items]))).toEqual(["c", "a", "d", "b", "new"])
  } finally {
    scope.stop()
  }
})

test("isolates order by Team, Machine and Workspace and clears a drag on a Team switch", () => {
  const scope = effectScope()
  try {
    const team = ref("first-team")
    const order = scope.run(() => createSidebarOrder(team))!
    const group = sessionOrderGroup("machine", "workspace")
    expect(order.move(group, items, "a", "d", "after")).toBe(true)
    for (const otherGroup of [machineOrderGroup, workspaceOrderGroup("machine"), sessionOrderGroup("machine"), sessionOrderGroup("other", "workspace")]) {
      expect(order.ordered(otherGroup, items)).toBe(items)
    }

    order.drag.value = { group, id: "a" }
    team.value = "second-team"
    expect(order.drag.value).toBeNull()
    expect(order.ordered(group, items)).toBe(items)
    expect(order.move(group, items, "b", "d", "after")).toBe(true)

    team.value = "first-team"
    expect(ids(order.ordered(group, items))).toEqual(["b", "c", "d", "a"])
    team.value = "second-team"
    expect(ids(order.ordered(group, items))).toEqual(["a", "c", "d", "b"])
  } finally {
    scope.stop()
  }
})
