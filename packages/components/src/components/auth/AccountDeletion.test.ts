import { DOMWrapper, flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import type { AccountAuthentication } from "@deskfleet/client/account-security"
import { i18n } from "../../i18n/index.ts"
import AccountDeletion from "./AccountDeletion.vue"

let view: VueWrapper | undefined
afterEach(() => { view?.unmount(); view = undefined })
const body = () => new DOMWrapper(document.body)
const button = (root: { findAll(selector: string): DOMWrapper<Element>[] }, label: string) => root.findAll("button").find(value => value.text() === label)!
const confirmed = <T>(action: () => Promise<T>) => action()

function pendingRequest() {
  return { id: "7", reason: "Moving on", status: "pending" as const, requestedAt: "2026-11-08T00:00:00.000Z", reviewedAt: null, reviewNote: null }
}

test("submits a deletion request and replaces the form with pending status", async () => {
  const account = {
    deletionRequest: vi.fn().mockResolvedValueOnce({ request: null }).mockResolvedValueOnce({ request: pendingRequest() }),
    requestDeletion: vi.fn(async () => pendingRequest()),
    cancelDeletion: vi.fn(async () => {}),
  } as unknown as AccountAuthentication
  view = mount(AccountDeletion, { props: { account, confirmed }, global: { plugins: [i18n] }, attachTo: document.body })
  await flushPromises()
  await button(view, "Request deletion").trigger("click")
  await flushPromises()
  const dialog = body().get('[role="dialog"]')
  await dialog.get('textarea[name="deletion-reason"]').setValue("  Moving on  ")
  await button(dialog, "Submit request").trigger("click")
  await flushPromises()
  expect(account.requestDeletion).toHaveBeenCalledExactlyOnceWith("Moving on")
  expect(account.deletionRequest).toHaveBeenCalledTimes(2)
  expect(body().find('[role="dialog"]').exists()).toBe(false)
  expect(view.text()).toContain("Waiting for a site administrator")
})

test("cancelling a pending request keeps the account active", async () => {
  const account = {
    deletionRequest: vi.fn()
      .mockResolvedValueOnce({ request: pendingRequest() })
      .mockResolvedValueOnce({ request: { ...pendingRequest(), status: "cancelled" } }),
    requestDeletion: vi.fn(async () => pendingRequest()),
    cancelDeletion: vi.fn(async () => {}),
  } as unknown as AccountAuthentication
  view = mount(AccountDeletion, { props: { account, confirmed }, global: { plugins: [i18n] }, attachTo: document.body })
  await flushPromises()
  await button(view, "Cancel request").trigger("click")
  await flushPromises()
  const dialog = body().get('[role="dialog"]')
  await button(dialog, "Cancel request").trigger("click")
  await flushPromises()
  expect(account.cancelDeletion).toHaveBeenCalledOnce()
  expect(view.text()).toContain("Request account deletion")
})
