import { getClient } from "@deskfleet/client/platform"
import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, disposePinia } from "pinia"
import { effectScope } from "vue"
import { afterEach, expect, test, vi } from "vitest"
import App from "../../App.vue"
import { createAccountSession } from "../../composables/useAccountSession.ts"
import { createMachineRuntimes, machineRuntimesKey } from "../../composables/useMachineRuntimes.ts"
import { router } from "../../router/index.ts"
import { useAppearanceStore } from "../../stores/appearance.ts"
import { fakeCentral, machineFixture } from "../../test/central.ts"
import MachineSurface from "./MachineSurface.vue"

vi.mock("../../App.vue", () => ({ default: { render: () => null } }))

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })

async function fixture(destination?: string) {
  const first = machineFixture("m1", "team-1", "First", false)
  const fake = fakeCentral({ machines: [first, machineFixture("m2", "team-1", "Second", false)] })
  const session = createAccountSession(fake.central)
  await flushPromises()
  const state = createPinia()
  const scope = effectScope()
  const runtimes = scope.run(() => createMachineRuntimes(getClient(), session, useAppearanceStore(state)))!
  cleanups.push(() => { scope.stop(); session.dispose(); disposePinia(state) })
  const runtime = runtimes.open(first)
  const unmount = vi.fn()
  const mountRuntime = vi.spyOn(runtime, "mount").mockReturnValue(unmount)
  const disposeRuntime = vi.spyOn(runtime, "dispose")
  const navigation = Promise.withResolvers<void>()
  vi.spyOn(router, "isReady").mockResolvedValue()
  const replace = vi.spyOn(router, "replace").mockReturnValue(navigation.promise)
  if (destination) vi.spyOn(session, "takeMachineDestination").mockReturnValue(destination)
  const view = mount(MachineSurface, {
    props: { session, machine: first },
    global: { provide: { [machineRuntimesKey as symbol]: runtimes } },
  })
  cleanups.push(() => view.unmount())
  await flushPromises()
  expect(replace).toHaveBeenCalledExactlyOnceWith(destination ?? "/")
  expect(mountRuntime).not.toHaveBeenCalled()
  return { ...fake, first, session, runtimes, runtime, mountRuntime, disposeRuntime, unmount, navigation, view }
}

test.each([undefined, "/sessions/30"])("mounts the current runtime only after navigation to %s settles", async destination => {
  const current = await fixture(destination)

  current.navigation.resolve()
  await flushPromises()

  expect(current.mountRuntime).toHaveBeenCalledExactlyOnceWith(App, current.view.element)
  expect(current.view.emitted("ready")).toEqual([["m1"]])
  current.view.unmount()
  expect(current.unmount).toHaveBeenCalledOnce()
})

test.each(["team", "account", "roster"] as const)("does not mount a runtime released by the %s while navigation is pending", async reason => {
  const current = await fixture()
  if (reason === "team") await current.session.selectTeam("team-2")
  else if (reason === "account") {
    current.central.status.mockResolvedValue({
      serverUrl: "https://fleet.example", siteAdmin: false,
      user: { id: "user-3", name: "Grace", email: "grace@example.test" },
    })
    await current.session.reload()
    expect(current.session.machineId.value).toBe("m1")
  } else await current.session.removeMachine("m1")
  await flushPromises()
  expect(current.disposeRuntime).toHaveBeenCalledOnce()
  expect(current.runtimes.opened.has("m1")).toBe(false)

  current.navigation.resolve()
  await flushPromises()

  expect(current.mountRuntime).not.toHaveBeenCalled()
  expect(current.view.emitted("ready")).toBeUndefined()
})

test("does not mount the previous runtime when the same machine has a replacement", async () => {
  const current = await fixture("/sessions/30")
  current.session.account.value = {
    ...current.session.account.value,
    user: { id: "user-3", name: "Grace", email: "grace@example.test" },
  }
  const replacement = current.runtimes.open(current.first)
  expect(replacement).not.toBe(current.runtime)
  expect(current.session.machineId.value).toBe("m1")

  current.navigation.resolve()
  await flushPromises()

  expect(current.runtimes.opened.get("m1")).toBe(replacement)
  expect(current.mountRuntime).not.toHaveBeenCalled()
  expect(current.view.emitted("ready")).toBeUndefined()
})

test("does not mount a retained runtime after another machine is selected during navigation", async () => {
  const current = await fixture()
  current.session.selectMachine("m2")

  current.navigation.resolve()
  await flushPromises()

  expect(current.runtimes.opened.get("m1")).toBe(current.runtime)
  expect(current.disposeRuntime).not.toHaveBeenCalled()
  expect(current.mountRuntime).not.toHaveBeenCalled()
  expect(current.view.emitted("ready")).toBeUndefined()
})
