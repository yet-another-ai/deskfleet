import { createHash } from "node:crypto"
import { flushPromises, mount } from "@vue/test-utils"
import { afterEach, expect, test, vi } from "vitest"
import UserAvatar from "./UserAvatar.vue"

const hash = createHash("sha256").update("ada@example.test").digest("hex")

function stubImage(outcome: "load" | "error") {
  vi.stubGlobal("Image", class {
    referrerPolicy = ""
    onload: (() => void) | null = null
    onerror: ((event?: unknown) => void) | null = null
    set src(_url: string) {
      queueMicrotask(() => {
        if (outcome === "load") this.onload?.()
        else this.onerror?.(new Event("error"))
      })
    }
  })
}

afterEach(() => { vi.unstubAllGlobals() })

test("a member's Gravatar covers their initials, keyed by the normalized address", async () => {
  stubImage("load")
  const view = mount(UserAvatar, { props: { name: "ada", email: "  Ada@Example.TEST ", size: 32 } })
  expect(view.text()).toBe("A")
  expect(view.get("span").attributes("title")).toBe("ada")
  await vi.waitFor(() => expect(view.get("img").attributes("src")).toBe(`https://gravatar.com/avatar/${hash}?s=64&d=404`))
})

test("an address without a Gravatar keeps the named placeholder", async () => {
  stubImage("error")
  const view = mount(UserAvatar, { props: { name: "Ada Lovelace", email: "ada@example.test", size: 24 } })
  await flushPromises()
  await vi.waitFor(() => expect(view.find("img").exists()).toBe(false))
  expect(view.text()).toBe("AL")
  expect(view.get("span").attributes("title")).toBe("Ada Lovelace")
})

test("a failed lookup stays on the named placeholder", async () => {
  stubImage("error")
  const view = mount(UserAvatar, { props: { name: "Ada", email: "ada@example.test", size: 24, label: "Ada is viewing" } })
  await flushPromises()
  await vi.waitFor(() => expect(view.find("img").exists()).toBe(false))
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
