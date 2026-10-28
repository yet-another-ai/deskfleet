import { afterEach, expect, test, vi } from "vitest"
import { createApp, h, nextTick, Teleport, type App, type Component } from "vue"
import { createMemoryHistory, createRouter, RouterLink } from "vue-router"
import { nativeDragPolicy } from "./native-drag.ts"

const apps: App[] = []
afterEach(() => { for (const app of apps.splice(0)) app.unmount() })

function mount(component: Component) {
  const host = document.createElement("div")
  document.body.append(host)
  const app = createApp(component).use(nativeDragPolicy)
  apps.push(app)
  return { app, host }
}

function drag(source: Element) {
  const event = new Event("dragstart", { bubbles: true, cancelable: true })
  source.dispatchEvent(event)
  return event
}

test("blocks native link drags from nested icons while preserving router navigation", async () => {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: "/", component: { render: () => null } },
    { path: "/settings", component: { render: () => null } },
  ] })
  const { app, host } = mount({ render: () => h(RouterLink, { to: "/settings" }, () => h("svg", [h("path")])) })
  app.use(router)
  await router.push("/")
  app.mount(host)
  await nextTick()
  expect(drag(host.querySelector("path")!).defaultPrevented).toBe(true)
  const link = host.querySelector("a")!
  const modifiedClick = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true })
  link.dispatchEvent(modifiedClick)
  expect(modifiedClick.defaultPrevented).toBe(false)
  expect(router.currentRoute.value.path).toBe("/")
  link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
  await vi.waitFor(() => expect(router.currentRoute.value.path).toBe("/settings"))
})

test("covers icons and teleported links, then releases the document listener on unmount", () => {
  const { app, host } = mount({ render: () => [
    h("button", [h("img", { src: "/icon.svg" })]),
    h(Teleport, { to: "body" }, h("a", { href: "/account", "data-portal-link": "" }, "Account")),
  ] })
  app.mount(host)
  expect(drag(host.querySelector("img")!).defaultPrevented).toBe(true)
  const portalLink = document.querySelector("[data-portal-link]")!
  expect(host.contains(portalLink)).toBe(false)
  expect(drag(portalLink).defaultPrevented).toBe(true)
  apps.splice(apps.indexOf(app), 1)
  app.unmount()
  const link = document.createElement("a")
  link.href = "/account"
  document.body.append(link)
  expect(drag(link).defaultPrevented).toBe(false)
})

test("preserves selectable content, text dragging, and explicit draggable controls", () => {
  const { app, host } = mount({ render: () => [
    h("div", { class: "ui-markdown" }, [h("a", { href: "https://example.com" }, "Reference")]),
    h("div", { class: "select-text" }, [h("img", { src: "/attachment.png" })]),
    h("p", "Selected text"),
    h("a", { href: "/item" }, [h("span", { draggable: "true" }, "Move item")]),
  ] })
  app.mount(host)
  for (const source of host.querySelectorAll(".ui-markdown a, img, p, [draggable]")) {
    expect(drag(source).defaultPrevented).toBe(false)
  }
})

test("leaves incoming file drop and pointer interactions to their controls", () => {
  const drop = vi.fn()
  const pointer = vi.fn()
  const { app, host } = mount({ render: () => h("div", { onDrop: drop, onPointerdown: pointer }, "Drop files") })
  app.mount(host)
  const target = host.firstElementChild!
  for (const name of ["dragenter", "dragover", "drop", "pointerdown"]) {
    const event = new Event(name, { bubbles: true, cancelable: true })
    target.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  }
  expect(drop).toHaveBeenCalledOnce()
  expect(pointer).toHaveBeenCalledOnce()
})
