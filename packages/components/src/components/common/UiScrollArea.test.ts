import { nextTick } from "vue"
import { mount } from "@vue/test-utils"
import { expect, test } from "vitest"
import UiScrollArea from "./UiScrollArea.vue"

function mockScrollMetrics(
  element: HTMLElement,
  metrics: { scrollHeight: number; clientHeight: number; scrollTop?: number; scrollWidth?: number; clientWidth?: number; scrollLeft?: number },
): void {
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, get: () => metrics.scrollHeight },
    clientHeight: { configurable: true, get: () => metrics.clientHeight },
    scrollWidth: { configurable: true, get: () => metrics.scrollWidth ?? 100 },
    clientWidth: { configurable: true, get: () => metrics.clientWidth ?? 100 },
  })
  element.scrollTop = metrics.scrollTop ?? 0
  element.scrollLeft = metrics.scrollLeft ?? 0
}

test("exposes viewport element, toggles focusability, and updates edge fade masks from scroll position", async () => {
  const view = mount(UiScrollArea, {
    props: { viewportAttrs: { "data-test-viewport": "" } },
    slots: { default: "<div>Scrollable content</div>" },
  })
  await nextTick()

  const exposed = view.vm as InstanceType<typeof UiScrollArea>
  const viewport = view.get<HTMLElement>("[data-test-viewport]").element
  const mask = view.get<HTMLElement>(".ui-scroll-mask").element
  expect(exposed.viewportElement).toBe(viewport)
  expect(viewport.getAttribute("tabindex")).toBe("0")

  mockScrollMetrics(viewport, { scrollHeight: 200, clientHeight: 200, scrollTop: 0 })
  exposed.measure()
  await nextTick()
  expect(mask.style.getPropertyValue("--ui-scroll-fade-top")).toBe("0px")
  expect(mask.style.getPropertyValue("--ui-scroll-fade-bottom")).toBe("0px")

  mockScrollMetrics(viewport, { scrollHeight: 500, clientHeight: 200, scrollTop: 0 })
  await view.get("[data-test-viewport]").trigger("scroll")
  expect(mask.style.getPropertyValue("--ui-scroll-fade-top")).toBe("0px")
  expect(mask.style.getPropertyValue("--ui-scroll-fade-bottom")).toBe("24px")

  viewport.scrollTop = 120
  await view.get("[data-test-viewport]").trigger("scroll")
  expect(mask.style.getPropertyValue("--ui-scroll-fade-top")).toBe("24px")
  expect(mask.style.getPropertyValue("--ui-scroll-fade-bottom")).toBe("24px")

  viewport.scrollTop = 300
  await view.get("[data-test-viewport]").trigger("scroll")
  expect(mask.style.getPropertyValue("--ui-scroll-fade-top")).toBe("24px")
  expect(mask.style.getPropertyValue("--ui-scroll-fade-bottom")).toBe("0px")

  await view.setProps({ focusable: false, fade: "top", fadeSize: "sm" })
  viewport.scrollTop = 120
  await view.get("[data-test-viewport]").trigger("scroll")
  expect(viewport.hasAttribute("tabindex")).toBe(false)
  expect(mask.style.getPropertyValue("--ui-scroll-fade-top")).toBe("16px")
  expect(mask.style.getPropertyValue("--ui-scroll-fade-bottom")).toBe("0px")

  view.unmount()
})
