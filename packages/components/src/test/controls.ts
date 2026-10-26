import { DOMWrapper, flushPromises, type VueWrapper } from "@vue/test-utils"

/** Choose through the visible control; options are teleported outside the mounted view. */
export async function selectOption(view: VueWrapper, selector: string, label: string): Promise<void> {
  const trigger = view.get(selector)
  ;(trigger.element as HTMLElement).focus()
  await trigger.trigger("keydown", { key: "ArrowDown" })
  await flushPromises()
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(element => element.textContent?.trim() === label)
  if (!option) throw new Error(`Option not found: ${label}`)
  option.focus()
  if (trigger.element instanceof HTMLInputElement) await new DOMWrapper(option).trigger("click")
  else await new DOMWrapper(option).trigger("keydown", { key: "Enter" })
  await flushPromises()
}

export async function setTime(view: VueWrapper, selector: string, value: string): Promise<void> {
  const segments = view.get(selector).findAll('[role="spinbutton"]')
  for (const [index, part] of value.split(":").entries()) {
    const segment = segments[index]!
    ;(segment.element as HTMLElement).focus()
    await segment.trigger("keydown", { key: "Backspace" })
    await segment.trigger("keydown", { key: "Backspace" })
    for (const key of part) await segment.trigger("keydown", { key })
  }
  await flushPromises()
}
