export const APP_LOCALES = ["en-US", "zh-cmn-Hans-CN"] as const
export type AppLocale = (typeof APP_LOCALES)[number]
export const DEFAULT_LOCALE: AppLocale = "en-US"

/** The main process passes its resolved locale to the preload through argv. */
export const LOCALE_ARGUMENT_PREFIX = "--deskfleet-locale="

export type MessageTree = { readonly [key: string]: string | MessageTree }

export function isAppLocale(value: unknown): value is AppLocale {
  return APP_LOCALES.includes(value as AppLocale)
}

function supportedLocale(tag: string): AppLocale | null {
  let locale: Intl.Locale
  try {
    locale = new Intl.Locale(tag).maximize()
  } catch {
    return null
  }
  if (locale.language === "en") return "en-US"
  if (locale.language === "zh" && locale.script === "Hans") return "zh-cmn-Hans-CN"
  return null
}

/** Picks the first supported locale from the OS preference order. */
export function resolveAppLocale(preferredLanguages: readonly string[]): AppLocale {
  for (const tag of preferredLanguages) {
    const locale = supportedLocale(tag)
    if (locale) return locale
  }
  return DEFAULT_LOCALE
}

/** Resolves a dotted key and `{name}` parameters; returns the key when it is missing. */
export function translate(
  messages: MessageTree,
  key: string,
  params?: Readonly<Record<string, string | number>>,
): string {
  let node: string | MessageTree | undefined = messages
  for (const part of key.split(".")) {
    if (!node || typeof node === "string") return key
    node = node[part]
  }
  if (typeof node !== "string") return key
  if (!params) return node
  return node.replace(/\{(\w+)\}/gu, (match, name: string) =>
    params[name] === undefined ? match : String(params[name]),
  )
}

/** The tag to pass to `Intl`, whose constructors reject the `cmn` extlang. */
export function intlLocale(locale: AppLocale): string {
  return locale === "zh-cmn-Hans-CN" ? "zh-Hans-CN" : locale
}
