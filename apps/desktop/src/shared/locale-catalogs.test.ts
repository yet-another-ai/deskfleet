import { readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { expect, test } from "vitest"
import { APP_LOCALES, type MessageTree } from "../../../../packages/client/src/i18n.ts"

const sourceRoot = resolve(import.meta.dirname, "../../../../packages/components/src")
const localeRoot = resolve(import.meta.dirname, "../../../../packages/components/locales")

function flatten(tree: MessageTree, prefix = ""): Record<string, string> {
  return Object.fromEntries(
    Object.entries(tree).flatMap(([key, value]) =>
      typeof value === "string"
        ? [[prefix + key, value]]
        : Object.entries(flatten(value, `${prefix}${key}.`)),
    ),
  )
}

const catalogs = APP_LOCALES.map((locale) =>
  flatten(JSON.parse(readFileSync(resolve(localeRoot, `${locale}.json`), "utf8"))),
)
const english = catalogs[0]!

test("catalogs share keys, nonempty messages, and parameters", () => {
  const parameters = (text: string) => [...new Set(text.match(/\{\w+\}/gu) ?? [])].sort()
  for (const catalog of catalogs) {
    expect(Object.keys(catalog).sort()).toEqual(Object.keys(english).sort())
    for (const [key, message] of Object.entries(catalog)) {
      expect(message.trim(), key).not.toBe("")
      expect(parameters(message), key).toEqual(parameters(english[key]!))
    }
  }
})

test("literal translation keys in the source exist", () => {
  const files = readdirSync(sourceRoot, { recursive: true, encoding: "utf8" }).filter(
    (file) => /\.(ts|vue)$/u.test(file) && !/\.test\.ts$/u.test(file),
  )
  const keys = files.flatMap((file) =>
    [...readFileSync(resolve(sourceRoot, file), "utf8").matchAll(/\bt\(\s*["']([\w.]+)["']/gu)].map(
      (match) => match[1]!,
    ),
  )
  expect(keys.length).toBeGreaterThan(0)
  for (const key of keys) expect(english, key).toHaveProperty([key])
})
