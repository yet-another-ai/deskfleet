import { mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import type { RelayDeniedReason } from "@deskfleet/client/relay"
import { accountSessionKey, type AccountSession } from "../../composables/useAccountSession.ts"
import { i18n } from "../../i18n/index.ts"
import ErrorNotice from "./ErrorNotice.vue"

let wrapper: VueWrapper | undefined
afterEach(() => { wrapper?.unmount(); i18n.global.locale.value = "en-US" })

function render(props: InstanceType<typeof ErrorNotice>["$props"], account?: Pick<AccountSession, "openSettings">) {
  wrapper = mount(ErrorNotice, { props, global: { plugins: [i18n], provide: account ? { [accountSessionKey as symbol]: account } : {} } })
  return wrapper
}

test("keeps raw diagnostics inside an initially collapsed disclosure", async () => {
  const view = render({ error: new Error("Capture failed\nDXGI_ERROR_ACCESS_LOST"), title: "Could not connect", description: "Unlock the machine and try again." })
  expect(view.get('[role="alert"]').text()).toContain("Could not connect")
  expect(view.get("details").element.open).toBe(false)
  expect(view.get("pre").text()).toBe("Capture failed\nDXGI_ERROR_ACCESS_LOST")
  await view.get("summary").trigger("click")
  expect(view.get("details").element.open).toBe(true)
  await view.get("summary").trigger("click")
  expect(view.get("details").element.open).toBe(false)
})

test("renders an unknown object as plain text and never as HTML", () => {
  const view = render({ error: { message: '<img src=x onerror="alert(1)">\n<em>failure</em>' } })
  expect(view.get('[role="alert"]').text()).toContain("Something went wrong")
  expect(view.find("img").exists()).toBe(false)
  expect(view.find("em").exists()).toBe(false)
  expect(view.get("pre").text()).toContain('<img src=x onerror="alert(1)">')
})

test.each(["free_plan", "turn_quota_exhausted"] as RelayDeniedReason[])("offers billing for %s and opens the selected Team's plans", async reason => {
  const openSettings = vi.fn()
  const view = render({ error: "Original connection failure", relayDeniedReason: reason, description: "Unlock the machine." }, { openSettings })
  expect(view.text()).not.toContain("Unlock the machine.")
  expect(view.get("button").text()).toBe("View billing")
  await view.get("button").trigger("click")
  expect(openSettings).toHaveBeenCalledExactlyOnceWith("plans")
})

test("a metering outage suggests trying again without offering billing", () => {
  const view = render({ relayDeniedReason: "metering_unavailable" }, { openSettings: vi.fn() })
  expect(view.text()).toContain("Relay connections are temporarily unavailable")
  expect(view.find("button").exists()).toBe(false)
  expect(view.find("details").exists()).toBe(false)
})

test("a local-only client does not offer an unavailable billing action", () => {
  const view = render({ relayDeniedReason: "turn_quota_exhausted" })
  expect(view.find("button").exists()).toBe(false)
})

test("an uncertain operation can suppress failure and retry advice", () => {
  const view = render({ error: "Failed to fetch", title: "Check the operation result", description: "" })
  expect(view.get('[role="alert"]').text()).toContain("Check the operation result")
  expect(view.text()).not.toContain(i18n.global.t("errors.network.description"))
  expect(view.get("pre").text()).toBe("Failed to fetch")
})

test("localizes the summary and details control", () => {
  i18n.global.locale.value = "zh-cmn-Hans-CN"
  const view = render({ error: "Failed to fetch" })
  expect(view.text()).toContain("无法连接到服务器")
  expect(view.get("summary").text()).toBe("技术详情")
})
