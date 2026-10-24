import { expect, test } from "vitest"
import { intlLocale, resolveAppLocale, translate } from "../../../../packages/client/src/i18n.ts"

test.each([
  [["zh-Hans-CN", "en-US"], "zh-cmn-Hans-CN"],
  [["zh-CN"], "zh-cmn-Hans-CN"],
  [["zh-SG"], "zh-cmn-Hans-CN"],
  [["zh-TW", "en-GB"], "en-US"],
  [["fr-FR", "zh-Hans"], "zh-cmn-Hans-CN"],
  [["fr-FR"], "en-US"],
  [["not a tag"], "en-US"],
  [[], "en-US"],
])("resolves OS preferences %j to %s", (preferred, locale) => {
  expect(resolveAppLocale(preferred)).toBe(locale)
})

test("translates nested keys and parameters, returning missing keys unchanged", () => {
  const messages = { tray: { greeting: "Hello {name}, {missing}" } }
  expect(translate(messages, "tray.greeting", { name: "Ada" })).toBe("Hello Ada, {missing}")
  expect(translate(messages, "tray")).toBe("tray")
  expect(translate(messages, "tray.greeting.deeper")).toBe("tray.greeting.deeper")
})

test("formatting locales are ones Intl has data for", () => {
  for (const locale of ["en-US", "zh-cmn-Hans-CN"] as const) {
    const tag = intlLocale(locale)
    expect(Intl.DateTimeFormat.supportedLocalesOf(tag)).toEqual([tag])
  }
})
