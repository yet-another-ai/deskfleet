import { mount } from "@vue/test-utils"
import { afterEach, expect, test } from "vitest"
import { i18n } from "../../i18n/index.ts"
import UiField from "./UiField.vue"

afterEach(() => { document.body.innerHTML = "" })

test("a password field reveals its value on demand and keeps the hint as its description", async () => {
  const view = mount(UiField, {
    props: { label: "New password", type: "password", hint: "15–128 characters." },
    attachTo: document.body,
    global: { plugins: [i18n] },
  })
  const input = view.get("input")
  expect(input.attributes("type")).toBe("password")
  expect(input.attributes("aria-describedby")).toBe(view.get("span").attributes("id"))

  await view.get("button").trigger("click")
  expect(input.attributes("type")).toBe("text")
  expect(view.get("button").attributes("aria-pressed")).toBe("true")

  await view.get("button").trigger("click")
  expect(input.attributes("type")).toBe("password")
  view.unmount()
})
