import { resolveAppLocale } from "@deskfleet/client/i18n"

const languageCheckedKey = "deskfleet-site-language-checked"
const homePaths = { "en-US": "/", "zh-cmn-Hans-CN": "/zh/", "ja-JP": "/ja/" } as const

export function firstVisitLanguageRedirect(
  browser: {
    readonly localStorage: Pick<Storage, "getItem" | "setItem">
    readonly location: Pick<Location, "pathname" | "search" | "hash">
  },
  languages: readonly string[],
): string | undefined {
  try {
    if (browser.localStorage.getItem(languageCheckedKey)) return
    // Commit even a no-op decision before navigating, including explicit locale URLs.
    browser.localStorage.setItem(languageCheckedKey, "1")
  } catch {
    // Without persistence, leave the visitor's language choice untouched.
    return
  }

  const { pathname, search, hash } = browser.location
  if (pathname !== "/" && pathname !== "/index" && pathname !== "/index.html") return
  const target = homePaths[resolveAppLocale(languages)]
  if (target !== "/") return `${target}${search}${hash}`
}
