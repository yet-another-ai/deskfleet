import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import type { CentralApi } from "@deskfleet/client/central"
import { i18n } from "../../i18n/index.ts"
import EnrollMachine from "./EnrollMachine.vue"

let view: VueWrapper | undefined
afterEach(() => { view?.unmount(); view = undefined })
function setup() {
  const enrollHeadless = vi.fn(async () => ({ machine: { id: "new-machine" }, token: "private-credential" }))
  const central = { enrollHeadless } as unknown as CentralApi
  view = mount(EnrollMachine, { props: { central, teamId: "team-1", serverUrl: "https://fleet.example" }, global: { plugins: [i18n] }, attachTo: document.body })
  return enrollHeadless
}

test("registers a machine and reveals selectable import instructions with one-time credentials", async () => {
  const enroll = setup()
  expect(document.activeElement).toBe(view!.get('[name="machine-name"]').element)
  expect(view!.get("pre").classes()).toContain("select-text")
  await view!.get('[name="machine-name"]').setValue("SSH server")
  await view!.get('[name="origin-id"]').setValue("origin-1")
  await view!.get('[name="local-machine-id"]').setValue("1")
  await view!.get("form").trigger("submit")
  await flushPromises()
  expect(enroll).toHaveBeenCalledExactlyOnceWith("team-1", { name: "SSH server", originId: "origin-1", localMachineId: "1" })
  expect(view!.emitted("enrolled")).toEqual([[]])
  expect(view!.find("form").exists()).toBe(false)
  const input = view!.get("textarea").element as HTMLTextAreaElement
  expect(document.activeElement).toBe(input)
  expect(JSON.parse(input.value)).toEqual({ machineId: "new-machine", teamId: "team-1", token: "private-credential" })
  expect(view!.get("pre").text()).toBe("deskfleet-daemon enroll --server-url https://fleet.example")
  await view!.get("button").trigger("click")
  expect(view!.emitted("close")).toEqual([[]])
})

test("keeps the entered identity when registration fails", async () => {
  const enroll = setup()
  enroll.mockRejectedValueOnce(new Error("Machine unavailable"))
  await view!.get('[name="machine-name"]').setValue("SSH server")
  await view!.get('[name="origin-id"]').setValue("origin-1")
  await view!.get('[name="local-machine-id"]').setValue("1")
  await view!.get("form").trigger("submit")
  await flushPromises()
  expect(view!.get('[role="alert"]').text()).toBe("Machine unavailable")
  expect((view!.get('[name="origin-id"]').element as HTMLInputElement).value).toBe("origin-1")
  expect(view!.emitted("enrolled")).toBeUndefined()
})
