import type { SystemStatus } from "@deskfleet/client/system"
import { mount } from "@vue/test-utils"
import { createPinia, disposePinia, setActivePinia } from "pinia"
import { expect, test, vi } from "vitest"
import { i18n } from "../../i18n/index.ts"
import { useMachineBatteriesStore } from "../../stores/machine-batteries.ts"
import MachineBatteryIndicator from "./MachineBatteryIndicator.vue"

type Battery = NonNullable<SystemStatus["battery"]>

function setup(battery: Battery | undefined, online = true) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useMachineBatteriesStore()
  vi.spyOn(store, "forMachine").mockReturnValue(battery)
  const observe = vi.spyOn(store, "observe")
  const wrapper = mount(MachineBatteryIndicator, {
    props: { machineId: "machine-1", online },
    global: { plugins: [pinia, i18n] },
  })
  return { wrapper, observe, pinia }
}

test("renders the charge level and charging state", () => {
  const { wrapper, observe, pinia } = setup({ percent: 68.4, state: "charging" })
  const indicator = wrapper.get("[data-machine-battery]")
  expect(indicator.attributes("aria-label")).toBe("Battery 68%, Charging")
  expect(indicator.attributes("data-battery-state")).toBe("charging")
  expect(indicator.findAll("svg")).toHaveLength(2)
  expect(Number(indicator.findAll("rect")[2]!.attributes("width"))).toBeCloseTo(6.156, 3)
  expect(observe).toHaveBeenCalledWith("machine-1")
  wrapper.unmount()
  disposePinia(pinia)
})

test("marks a low discharging battery as a warning", () => {
  const { wrapper, pinia } = setup({ percent: 12, state: "discharging" })
  const indicator = wrapper.get("[data-machine-battery]")
  expect(indicator.attributes("aria-label")).toBe("Battery 12%, On battery")
  expect(indicator.classes()).toContain("text-ui-warning")
  expect(indicator.findAll("svg")).toHaveLength(1)
  wrapper.unmount()
  disposePinia(pinia)
})

test("hides and stops observing a battery on an offline machine", () => {
  const { wrapper, observe, pinia } = setup({ percent: 68.4, state: "charging" }, false)
  expect(wrapper.find("[data-machine-battery]").exists()).toBe(false)
  expect(observe).not.toHaveBeenCalled()
  wrapper.unmount()
  disposePinia(pinia)
})

test("renders nothing when the machine has no battery", () => {
  const { wrapper, observe, pinia } = setup(undefined)
  expect(wrapper.find("[data-machine-battery]").exists()).toBe(false)
  expect(observe).toHaveBeenCalledWith("machine-1")
  wrapper.unmount()
  disposePinia(pinia)
})
