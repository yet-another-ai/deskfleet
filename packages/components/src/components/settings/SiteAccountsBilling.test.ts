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
    billing: { ...billingFixture(), plan: "go", subscription: { plan: "go", status: "active", paidThrough: "2026-11-28T00:00:00Z", cancelAtPeriodEnd: false } },
  }] as never)
  view = mount(EnterpriseTeams, { props: { api: central, confirmed }, global: { plugins: [i18n] }, attachTo: document.body })
  await flushPromises()
  expect(view.get("[data-enterprise-team]").text()).toContain("Go subscription · active")
  await button(view, "Grant Enterprise").trigger("click"); await flushPromises()
  const dialog = body().get('[role="dialog"]')
  expect(dialog.text()).toContain("Its Go subscription keeps billing until a Team admin cancels it.")
  await button(dialog, "Grant Enterprise").trigger("click"); await flushPromises()
  expect(central.setEnterprise).toHaveBeenCalledExactlyOnceWith("team-1", true)
  expect(central.billingTeams).toHaveBeenCalledTimes(2)
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
