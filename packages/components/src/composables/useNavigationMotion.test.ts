import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { defineComponent, h, nextTick, ref, type Ref } from "vue"
import { createMemoryHistory, createRouter, RouterView } from "vue-router"
import { afterEach, expect, test } from "vitest"
import type { NavigationTransition } from "../services/navigation-motion.ts"
import { provideNavigationMotion, useNavigationMotion } from "./useNavigationMotion.ts"

let wrapper: VueWrapper | undefined
afterEach(() => { wrapper?.unmount(); wrapper = undefined })

function fixture() {
  const consumed: Readonly<Ref<NavigationTransition>>[] = []
  let mounts = 0
  const page = defineComponent({ setup() {
    mounts++
    const transition = useNavigationMotion()
    consumed.push(transition)
    return () => h("article", { "data-motion": transition.value.motion }, transition.value.key)
  } })
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: "/schedules/:scheduleId?", name: "schedules", component: page },
    { path: "/settings/developer", name: "settings-developer", component: page },
    { path: "/settings/developer/nat", name: "settings-developer-nat", component: page },
    { path: "/search", name: "search", component: page },
    { path: "/redirect", redirect: "/settings/developer/nat" },
  ] })
  const provided: Readonly<Ref<NavigationTransition>>[] = []
  const provider = defineComponent({ setup() {
    provided.push(provideNavigationMotion())
    return () => h(RouterView)
  } })
  return { router, provider, provided, consumed, mounts: () => mounts }
}

test("provided motion follows page identity while same-component navigation preserves its instance", async () => {
  const current = fixture()
  await current.router.push("/schedules")
  wrapper = mount(current.provider, { global: { plugins: [current.router] } })
  expect(current.consumed[0]).toBe(current.provided[0])
  expect(wrapper.get("article").attributes("data-motion")).toBe("peer")
  await current.router.push("/schedules/new")
  expect(wrapper.get("article").attributes("data-motion")).toBe("enter")
  await current.router.replace("/schedules/task-1")
  expect(wrapper.get("article").attributes("data-motion")).toBe("peer")
  const transition = current.provided[0]!.value
  await current.router.replace("/schedules/task-1?entry=message#details")
  expect(current.provided[0]!.value).toBe(transition)
  await current.router.replace("/schedules")
  expect(wrapper.get("article").attributes("data-motion")).toBe("return")
  expect(current.mounts()).toBe(1)
})

test("replace and browser history use the actual Developer/NAT relationship", async () => {
  const current = fixture()
  await current.router.push("/settings/developer")
  wrapper = mount(current.provider, { global: { plugins: [current.router] } })
  await current.router.replace("/settings/developer/nat")
  expect(current.provided[0]!.value.motion).toBe("enter")
  await current.router.replace("/settings/developer")
  expect(current.provided[0]!.value.motion).toBe("return")
  await current.router.push("/settings/developer/nat")
  current.router.back()
  await flushPromises()
  expect(current.provided[0]!.value.motion).toBe("return")
  current.router.forward()
  await flushPromises()
  expect(current.provided[0]!.value.motion).toBe("enter")
})

test("standalone shells provide no directional entrance and track subsequent navigation locally", async () => {
  const current = fixture()
  await current.router.push("/settings/developer")
  const standalone = defineComponent({ setup() {
    const transition = useNavigationMotion()
    return () => h("main", { "data-motion": transition.value.motion })
  } })
  wrapper = mount(standalone, { global: { plugins: [current.router] } })
  expect(wrapper.attributes("data-motion")).toBe("peer")
  await current.router.replace("/settings/developer/nat")
  expect(wrapper.attributes("data-motion")).toBe("enter")
})

test("replacing an App scope starts at peer and disposes the old scope's route watcher", async () => {
  const current = fixture()
  await current.router.push("/settings/developer")
  const scope = ref("machine-a")
  const host = defineComponent({ setup: () => () => h(current.provider, { key: scope.value }) })
  wrapper = mount(host, { global: { plugins: [current.router] } })
  await current.router.push("/settings/developer/nat")
  const old = current.provided[0]!
  expect(old.value.motion).toBe("enter")
  scope.value = "machine-b"
  await nextTick()
  expect(current.provided[1]!.value.motion).toBe("peer")
  expect(current.provided[1]).not.toBe(old)
  await current.router.push("/settings/developer")
  expect(current.provided[1]!.value.motion).toBe("return")
  expect(old.value.motion).toBe("enter")
})

test("aborted navigation leaves the descriptor untouched and a redirect uses its final destination", async () => {
  const current = fixture()
  await current.router.push("/settings/developer")
  wrapper = mount(current.provider, { global: { plugins: [current.router] } })
  const initial = current.provided[0]!.value
  const removeGuard = current.router.beforeEach(to => to.name !== "search")
  await current.router.push("/search")
  expect(current.provided[0]!.value).toBe(initial)
  removeGuard()
  await current.router.push("/redirect")
  expect(current.provided[0]!.value.motion).toBe("enter")
})

test("a lazy destination reads the successful navigation from its persistent parent", async () => {
  const current = fixture()
  const destination = Promise.withResolvers<ReturnType<typeof defineComponent>>()
  const observed: NavigationTransition[] = []
  current.router.addRoute({ path: "/lazy", name: "lazy", component: () => destination.promise })
  await current.router.push("/schedules")
  wrapper = mount(current.provider, { global: { plugins: [current.router] } })
  const initial = current.provided[0]!.value
  const navigating = current.router.push("/lazy")
  await flushPromises()
  expect(current.provided[0]!.value).toBe(initial)
  destination.resolve(defineComponent({ setup() {
    observed.push(useNavigationMotion().value)
    return () => h("article")
  } }))
  await navigating
  await nextTick()
  expect(observed).toEqual([current.provided[0]!.value])
  expect(observed[0]!.key).not.toBe(initial.key)
  expect(observed[0]!.motion).toBe("peer")
})
