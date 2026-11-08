import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test } from "vitest"
import { i18n } from "../../i18n/index.ts"
import { fakeCentral } from "../../test/central.ts"
import SiteDeletionRequests from "./SiteDeletionRequests.vue"

let view: VueWrapper | undefined
afterEach(() => { view?.unmount(); view = undefined })
const body = () => new DOMWrapper(document.body)
const button = (root: { findAll(selector: string): DOMWrapper<Element>[] }, label: string) => root.findAll("button").find(value => value.text() === label)!
const confirmed = <T>(action: () => Promise<T>) => action()
const request = {
  id: "10",
  reason: "Leaving the team",
  status: "pending" as const,
  requestedAt: "2026-11-08T00:00:00.000Z",
  user: { id: "user-2", name: "Grace", email: "grace@example.test" },
}

test("approving a deletion request submits the decision and reloads the queue", async () => {
  const { central } = fakeCentral()
  central.deletionRequests.mockResolvedValue({ requests: [request], nextCursor: null })
  view = mount(SiteDeletionRequests, { props: { api: central, confirmed }, global: { plugins: [i18n] }, attachTo: document.body })
  await flushPromises()
  expect(view.get("[data-deletion-request]").text()).toContain("Grace")
  expect(view.get("[data-deletion-request]").text()).toContain("Leaving the team")
  await button(view, "Approve deletion").trigger("click")
  await flushPromises()
  const dialog = body().get('[role="dialog"]')
  await dialog.get('textarea[name="deletion-review-note"]').setValue("Account verified")
  await button(dialog, "Approve deletion").trigger("click")
  await flushPromises()
  expect(central.reviewDeletionRequest).toHaveBeenCalledExactlyOnceWith("10", true, "Account verified")
  expect(central.deletionRequests).toHaveBeenCalledTimes(2)
})

test("rejecting a request sends a rejection without deleting the account", async () => {
  const { central } = fakeCentral()
  central.deletionRequests.mockResolvedValue({ requests: [request], nextCursor: null })
  view = mount(SiteDeletionRequests, { props: { api: central, confirmed }, global: { plugins: [i18n] }, attachTo: document.body })
  await flushPromises()
  await button(view, "Reject").trigger("click")
  await flushPromises()
  const dialog = body().get('[role="dialog"]')
  await button(dialog, "Reject").trigger("click")
  await flushPromises()
  expect(central.reviewDeletionRequest).toHaveBeenCalledExactlyOnceWith("10", false, undefined)
})
