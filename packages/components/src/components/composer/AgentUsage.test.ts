import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import { i18n } from "../../i18n/index.ts"
import type { AgentUsage as Usage } from "../../services/agent-usage.ts"
import AgentUsage from "./AgentUsage.vue"

let wrapper: VueWrapper
const page = () => new DOMWrapper(document.body)
const usage = (values: Partial<Usage> = {}): Usage => ({ sessionUpdate: "usage_update", used: 32_000, size: 128_000, ...values })
async function setup(value = usage()): Promise<void> {
  wrapper = mount(AgentUsage, { attachTo: document.body, props: { usage: value }, global: { plugins: [i18n] } })
  await wrapper.get("button").trigger("click")
  await flushPromises()
}
afterEach(() => { wrapper?.unmount(); i18n.global.locale.value = "en-US" })

test("shows current context and cumulative session cost, and returns focus on Escape", async () => {
  await setup(usage({ cost: { amount: 0.1234, currency: "USD" } }))
  expect(wrapper.get("button").attributes("aria-label")).toBe("Context usage: 25%")
  const dialog = page().get('[role="dialog"]')
  expect(dialog.attributes("aria-label")).toBe("Session usage")
  expect(dialog.get("[data-agent-usage-used]").text()).toBe("32,000 tokens")
  expect(dialog.get("[data-agent-usage-capacity]").text()).toBe("128,000 tokens")
  expect(dialog.get("[data-agent-usage-cost]").text().replace(/\s/g, " ")).toBe("USD 0.1234")
  expect(dialog.get('[role="progressbar"]').attributes("aria-valuenow")).toBe("32000")
  expect(dialog.get('[role="progressbar"]').attributes("aria-valuemax")).toBe("128000")
  await dialog.trigger("keydown", { key: "Escape" })
  await flushPromises()
  expect(page().find('[role="dialog"]').exists()).toBe(false)
  await vi.waitFor(() => expect(document.activeElement).toBe(wrapper.get("button").element))
})

test("updates usage after compaction and distinguishes missing cost from a reported zero", async () => {
  await setup(usage({ used: 120_000 }))
  expect(wrapper.get("button").classes()).toContain("text-ui-warning")
  expect(page().find("[data-agent-usage-cost]").exists()).toBe(false)
  await wrapper.setProps({ usage: usage({ used: 16_000, cost: { amount: 0, currency: "EUR" } }) })
  expect(wrapper.get("button").text()).toBe("13%")
  expect(wrapper.get("button").classes()).not.toContain("text-ui-warning")
  expect(page().get("[data-agent-usage-cost]").text().replace(/\s/g, " ")).toBe("EUR 0.00")
  await wrapper.setProps({ usage: usage({ used: 0, cost: null }) })
  expect(wrapper.get("button").text()).toBe("0%")
  expect(page().get("[data-agent-usage-used]").text()).toBe("0 tokens")
  expect(page().find("[data-agent-usage-cost]").exists()).toBe(false)
})

test("unknown capacity has no percentage, while over-capacity values retain their actual counts", async () => {
  await setup(usage({ used: 500, size: 0 }))
  expect(wrapper.get("button").text()).toBe("—")
  expect(page().get("[data-agent-usage-capacity]").text()).toBe("Unavailable")
  expect(page().find('[role="progressbar"]').exists()).toBe(false)
  await wrapper.setProps({ usage: usage({ used: 150_000 }) })
  expect(wrapper.get("button").text()).toBe("117%")
  expect(page().get("[data-agent-usage-used]").text()).toBe("150,000 tokens")
  const meter = page().get('[role="progressbar"]')
  expect(meter.attributes("aria-valuenow")).toBe("128000")
  expect(meter.get("div").attributes("style")).toContain("width: 100%")
})

test("uses the application locale for labels, token counts and currency", async () => {
  i18n.global.locale.value = "zh-cmn-Hans-CN"
  await setup(usage({ cost: { amount: 1.25, currency: "CNY" } }))
  expect(wrapper.get("button").attributes("aria-label")).toBe("上下文用量：25%")
  const dialog = page().get('[role="dialog"]')
  expect(dialog.attributes("aria-label")).toBe("会话用量")
  expect(dialog.text()).toContain("会话费用")
  expect(dialog.get("[data-agent-usage-used]").text()).toBe("32,000 token")
  expect(dialog.get("[data-agent-usage-cost]").text().replace(/\s/g, " ")).toBe("CNY 1.25")
})

test("preserves provider cost units that are not ISO currency codes", async () => {
  await setup(usage({ cost: { amount: 12.5, currency: "credits" } }))
  expect(page().get("[data-agent-usage-cost]").text()).toBe("12.50 credits")
})
