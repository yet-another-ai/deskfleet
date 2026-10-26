import { flushPromises, mount, type VueWrapper } from "@vue/test-utils"
import { afterEach, expect, test } from "vitest"
import { defineComponent, ref } from "vue"
import UiSelect from "./UiSelect.vue"
import UiCheckbox from "./UiCheckbox.vue"
import UiSwitch from "./UiSwitch.vue"
import UiTimeField from "./UiTimeField.vue"
import UiNumberField from "./UiNumberField.vue"
import { selectOption, setTime } from "../../test/controls.ts"
import { i18n } from "../../i18n/index.ts"

const views: VueWrapper[] = []
afterEach(() => { for (const view of views.splice(0)) view.unmount() })
function render(template: string, value: string | boolean | number = "") {
  const view = mount(defineComponent({
    components: { UiSelect, UiCheckbox, UiSwitch, UiTimeField, UiNumberField },
    setup: () => ({ value: ref(value), options: [{ value: "UTC", label: "UTC" }, { value: "Asia/Singapore", label: "Asia/Singapore" }, { value: "disabled", label: "Unavailable", disabled: true }] }),
    template,
  }), { attachTo: document.body, global: { plugins: [i18n] } })
  views.push(view)
  return view
}

test("select validates and serializes the chosen value through keyboard-operated options", async () => {
  const view = render('<form><UiSelect v-model="value" name="zone" :options="options" required aria-label="Zone" /></form>')
  await flushPromises()
  expect((view.get("form").element as HTMLFormElement).checkValidity()).toBe(false)
  await selectOption(view, '[role="combobox"]', "Asia/Singapore")
  expect(view.get('[role="combobox"]').text()).toContain("Asia/Singapore")
  expect((view.get("form").element as HTMLFormElement).checkValidity()).toBe(true)
  expect(new FormData(view.get("form").element as HTMLFormElement).get("zone")).toBe("Asia/Singapore")
})

test("search text cannot satisfy a required selection and filtering preserves canonical values", async () => {
  const view = render('<form><UiSelect v-model="value" name="zone" :options="options" searchable required aria-label="Zone" /></form>')
  await view.get('[role="combobox"]').setValue("missing-zone")
  await flushPromises()
  expect(document.querySelector('[role="listbox"]')?.textContent).toContain("No results found.")
  await view.get('[role="combobox"]').setValue("Singapore")
  await flushPromises()
  expect((view.get("form").element as HTMLFormElement).checkValidity()).toBe(false)
  expect(document.querySelector('[role="option"]')?.textContent).toContain("Asia/Singapore")
  await selectOption(view, '[role="combobox"]', "Asia/Singapore")
  expect(new FormData(view.get("form").element as HTMLFormElement).get("zone")).toBe("Asia/Singapore")
  expect((view.get("form").element as HTMLFormElement).checkValidity()).toBe(true)
})

test.each(["en-US", "zh-cmn-Hans-CN"])("time segments emit minute precision and clearing invalidates the form in %s", async locale => {
  const view = render(`<form><UiTimeField v-model="value" name="time" required locale="${locale}" aria-label="Time" /></form>`, "09:00")
  await setTime(view, '[role="group"]', "23:59")
  expect(new FormData(view.get("form").element as HTMLFormElement).get("time")).toBe("23:59")
  expect((view.get("form").element as HTMLFormElement).checkValidity()).toBe(true)
  await view.findAll('[role="spinbutton"]')[1]!.trigger("keydown", { key: "Backspace" })
  await view.findAll('[role="spinbutton"]')[1]!.trigger("keydown", { key: "Backspace" })
  await flushPromises()
  expect((view.get("form").element as HTMLFormElement).checkValidity()).toBe(false)
  expect(new FormData(view.get("form").element as HTMLFormElement).get("time")).toBe("")
})

test("checkboxes remain label-clickable and disabled switches remain inert", async () => {
  const view = render('<form><label><UiCheckbox v-model="value" name="accepted" required />Accept</label><UiSwitch v-model="value" disabled aria-label="Disabled" /></form>', false)
  ;(view.get("label").element as HTMLLabelElement).click()
  await flushPromises()
  expect(view.get('[role="checkbox"]').attributes("aria-checked")).toBe("true")
  await view.get('[role="switch"]').trigger("click")
  expect(view.get('[role="checkbox"]').attributes("aria-checked")).toBe("true")
  expect((view.get("form").element as HTMLFormElement).checkValidity()).toBe(true)
})

test("number cadence commits typed values and supports arrow keys", async () => {
  const view = render('<form><UiNumberField v-model="value" name="cadence" :min="1" :max="24" required aria-label="Cadence" /></form>', 1)
  await view.get('[role="spinbutton"]').setValue("3")
  await view.get('[role="spinbutton"]').trigger("keydown", { key: "ArrowUp" })
  expect((view.get('[role="spinbutton"]').element as HTMLInputElement).value).toBe("4")
  await view.get('[role="spinbutton"]').setValue("")
  expect((view.get("form").element as HTMLFormElement).checkValidity()).toBe(false)
})
