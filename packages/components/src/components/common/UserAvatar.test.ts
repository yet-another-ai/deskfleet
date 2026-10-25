import { createHash } from "node:crypto"
import { flushPromises, mount } from "@vue/test-utils"
import { expect, test, vi } from "vitest"
import UserAvatar from "./UserAvatar.vue"

const hash = createHash("sha256").update("ada@example.test").digest("hex")

test("a member's Gravatar covers their initial, keyed by the normalized address", async () => {
  const view = mount(UserAvatar, { props: { name: "ada", email: "  Ada@Example.TEST ", size: 32 } })
  expect(view.text()).toBe("A")
  // Web Crypto hashes off the main thread.
  await vi.waitFor(() => expect(view.get("img").attributes("src")).toBe(`https://gravatar.com/avatar/${hash}?s=64&d=404`))
})

test("an address without a Gravatar keeps the initial", async () => {
  const view = mount(UserAvatar, { props: { name: "Ada", email: "ada@example.test", size: 24 } })
  await vi.waitFor(() => view.get("img"))
  await view.get("img").trigger("error")
  expect(view.find("img").exists()).toBe(false)
  expect(view.text()).toBe("A")
})

test("a member without an address shows only the initial", async () => {
  const view = mount(UserAvatar, { props: { name: "Bob", email: null, size: 32 } })
  await flushPromises()
  expect(view.find("img").exists()).toBe(false)
  expect(view.text()).toBe("B")
})
