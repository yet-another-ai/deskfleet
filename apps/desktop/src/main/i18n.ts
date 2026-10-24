import enUS from "../../../../packages/components/locales/en-US.json"
import zhCmnHansCN from "../../../../packages/components/locales/zh-cmn-Hans-CN.json"
import { DEFAULT_LOCALE, translate, type AppLocale, type MessageTree } from "../../../../packages/client/src/i18n.ts"

const catalogs: Record<AppLocale, MessageTree> = {
  "en-US": enUS,
  "zh-cmn-Hans-CN": zhCmnHansCN,
}

let currentLocale: AppLocale = DEFAULT_LOCALE

export function getMainLocale(): AppLocale {
  return currentLocale
}

export function setMainLocale(locale: AppLocale): void {
  currentLocale = locale
}

export function t(key: string, params?: Readonly<Record<string, string | number>>): string {
  const localized = translate(catalogs[currentLocale], key, params)
  if (localized !== key || currentLocale === DEFAULT_LOCALE) return localized
  return translate(catalogs[DEFAULT_LOCALE], key, params)
}
