import { mount } from "@vue/test-utils"
import { afterEach, expect, test } from "vitest"
import { i18n } from "../../i18n/index.ts"
import SettingsLayout from "./SettingsLayout.vue"

let view: ReturnType<typeof mount> | undefined
afterEach(() => { view?.unmount(); view = undefined; document.body.replaceChildren() })

test("Escape leaves settings unless a dialog is open or the key was already handled", () => {
  view = mount(SettingsLayout, { global: { plugins: [i18n] }, slots: { default: "<p>Section</p>" } })
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
  expect(view.emitted("back")).toHaveLength(1)

  const handled = new KeyboardEvent("keydown", { key: "Escape", cancelable: true })
  handled.preventDefault()
  window.dispatchEvent(handled)
  expect(view.emitted("back")).toHaveLength(1)

  const dialog = document.createElement("dialog")
  document.body.append(dialog)
  dialog.showModal()
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
  expect(view.emitted("back")).toHaveLength(1)
  dialog.close()

  window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }))
  expect(view.emitted("back")).toHaveLength(1)
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
  expect(view.emitted("back")).toHaveLength(2)
})
