import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test } from "vitest"
import { i18n } from "../../i18n/index.ts"
import { billingFixture, fakeCentral } from "../../test/central.ts"
import EnterpriseTeams from "./EnterpriseTeams.vue"
import SiteIdentitySettings from "./SiteIdentitySettings.vue"

let view: VueWrapper | undefined
afterEach(() => { view?.unmount(); view = undefined })
const body = () => new DOMWrapper(document.body)
const button = (root: { findAll(selector: string): DOMWrapper<Element>[] }, label: string) => root.findAll("button").find(value => value.text() === label)!
const confirmed = <T>(action: () => Promise<T>) => action()

test("granting Enterprise states that the Team's paid subscription keeps billing", async () => {
  const { central } = fakeCentral()
  central.billingTeams.mockResolvedValue([{
    id: "team-1", name: "Design team",
    owner: { id: "user-1", name: "Ada", email: "ada@example.test" },
    billing: { ...billingFixture(), plan: "go", subscription: { plan: "go", status: "active", paidThrough: "2026-11-28T00:00:00Z", cancelAtPeriodEnd: false } },
  }])
  view = mount(EnterpriseTeams, { props: { api: central, confirmed }, global: { plugins: [i18n] }, attachTo: document.body })
  await flushPromises()
  expect(view.get("[data-enterprise-team]").text()).toContain("Go subscription · active")
  await button(view, "Grant Enterprise").trigger("click"); await flushPromises()
  const dialog = body().get('[role="dialog"]')
  expect(dialog.text()).toContain("Its Go subscription keeps billing until the Team owner cancels it.")
  await button(dialog, "Grant Enterprise").trigger("click"); await flushPromises()
  expect(central.setEnterprise).toHaveBeenCalledExactlyOnceWith("team-1", true)
  expect(central.billingTeams).toHaveBeenCalledTimes(2)
})

test("same-name Teams show their owner accounts and can be filtered by name or email", async () => {
  const { central } = fakeCentral()
  central.billingTeams.mockResolvedValue([
    { id: "team-1", name: "Design team", owner: { id: "user-1", name: "Ada", email: "ada@first.example" }, billing: billingFixture() },
    { id: "team-2", name: "Design team", owner: { id: "user-2", name: "Grace", email: "grace@example.test" }, billing: billingFixture() },
  ])
  view = mount(EnterpriseTeams, { props: { api: central, confirmed }, global: { plugins: [i18n] } })
  await flushPromises()
  expect(view.get('[data-enterprise-team="team-1"]').text()).toContain("Owner: Ada (ada@first.example)")
  expect(view.get('[data-enterprise-team="team-2"]').text()).toContain("Owner: Grace (grace@example.test)")
  const filter = view.get('input[name="team-filter"]')
  await filter.setValue("Design")
  expect(view.findAll("[data-enterprise-team]")).toHaveLength(2)
  await filter.setValue("Grace")
  expect(view.findAll("[data-enterprise-team]").map(row => row.attributes("data-enterprise-team"))).toEqual(["team-2"])
  await filter.setValue("  ADA@FIRST.EXAMPLE  ")
  expect(view.findAll("[data-enterprise-team]").map(row => row.attributes("data-enterprise-team"))).toEqual(["team-1"])
  await filter.setValue("")
  expect(view.findAll("[data-enterprise-team]")).toHaveLength(2)
})

test.each([false, true])("Enterprise confirmation identifies the selected same-name Team's accounts (override=%s)", async enterpriseOverride => {
  const { central } = fakeCentral()
  central.billingTeams.mockResolvedValue([
    { id: "team-1", name: "Design team", owner: { id: "user-1", name: "Ada", email: "ada@first.example" }, billing: billingFixture() },
    { id: "team-2", name: "Design team", owner: { id: "user-2", name: "Ada", email: "ada@second.example" }, billing: { ...billingFixture(), enterpriseOverride } },
  ])
  view = mount(EnterpriseTeams, { props: { api: central, confirmed }, global: { plugins: [i18n] }, attachTo: document.body })
  await flushPromises()
  const label = enterpriseOverride ? "Revoke Enterprise" : "Grant Enterprise"
  await button(view.get('[data-enterprise-team="team-2"]'), label).trigger("click"); await flushPromises()
  const dialog = body().get('[role="dialog"]')
  expect(dialog.text()).toContain("Owner: Ada (ada@second.example)")
  expect(dialog.text()).not.toContain("ada@first.example")
  expect(central.setEnterprise).not.toHaveBeenCalled()
  await button(dialog, label).trigger("click"); await flushPromises()
  expect(central.setEnterprise).toHaveBeenCalledExactlyOnceWith("team-2", !enterpriseOverride)
})

test("disabling an account is confirmed first; enabling it again is immediate", async () => {
  const { central } = fakeCentral()
  central.users.mockResolvedValue([{ id: "user-2", name: "Bob", email: "bob@example.test", disabled: false }] as never)
  view = mount(SiteIdentitySettings, { props: { api: central, confirmed }, global: { plugins: [i18n] }, attachTo: document.body })
  await flushPromises()
  await view.get('input[name="account-search"]').setValue("bob")
  await view.get('form[role="search"]').trigger("submit"); await flushPromises()
  expect(central.users).toHaveBeenCalledExactlyOnceWith("bob")
  await button(view, "Disable account").trigger("click"); await flushPromises()
  expect(central.disableUser).not.toHaveBeenCalled()
  await button(body().get('[role="dialog"]'), "Disable account").trigger("click"); await flushPromises()
  expect(central.disableUser).toHaveBeenCalledExactlyOnceWith("user-2", true)
  expect(view.get("[data-account-id]").text()).toContain("Disabled")
  await button(view, "Enable account").trigger("click"); await flushPromises()
  expect(central.disableUser).toHaveBeenLastCalledWith("user-2", false)
})
