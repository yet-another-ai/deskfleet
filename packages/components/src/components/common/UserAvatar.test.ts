import { createHash } from "node:crypto"
import { flushPromises, mount } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import UserAvatar from "./UserAvatar.vue"

const hash = createHash("sha256").update("ada@example.test").digest("hex")
const image = () => new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { "content-type": "image/png" } })

afterEach(() => { vi.unstubAllGlobals() })

test("a member's Gravatar covers their initials, keyed by the normalized address", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => image()))
  const view = mount(UserAvatar, { props: { name: "ada", email: "  Ada@Example.TEST ", size: 32 } })
  expect(view.text()).toBe("A")
  expect(view.get("span").attributes("title")).toBe("ada")
  await vi.waitFor(() => expect(view.get("img").attributes("src")).toBe(`https://gravatar.com/avatar/${hash}?s=64&d=404`))
})

test("an address without a Gravatar keeps the named placeholder", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("404 Not Found", { status: 404, headers: { "content-type": "text/html" } })))
  const view = mount(UserAvatar, { props: { name: "Ada Lovelace", email: "ada@example.test", size: 24 } })
  await flushPromises()
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
  expect(view.find("img").exists()).toBe(false)
  expect(view.text()).toBe("AL")
  expect(view.get("span").attributes("title")).toBe("Ada Lovelace")
})

test("a failed lookup stays on the named placeholder", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch") }))
  const view = mount(UserAvatar, { props: { name: "Ada", email: "ada@example.test", size: 24, label: "Ada is viewing" } })
  await flushPromises()
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
  expect(view.find("img").exists()).toBe(false)
  expect(view.text()).toBe("A")
  expect(view.get("span").attributes("title")).toBe("Ada is viewing")
})

test("a member without an address shows only their initials", async () => {
  const view = mount(UserAvatar, { props: { name: "Bob", email: null, size: 32 } })
  await flushPromises()
  expect(view.find("img").exists()).toBe(false)
  expect(view.text()).toBe("B")
  expect(view.get("span").attributes("title")).toBe("Bob")
})
