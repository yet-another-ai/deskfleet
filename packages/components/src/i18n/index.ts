import { client as platformClient } from "@deskfleet/client/platform"
import { createI18n } from "vue-i18n"
import enUS from "../../locales/en-US.json"
import jaJP from "../../locales/ja-JP.json"
import zhCmnHansCN from "../../locales/zh-cmn-Hans-CN.json"
import { DEFAULT_LOCALE } from "../../../client/src/i18n.ts"

// Components use `useI18n()`; Vapor components do not receive global `$t`.
export const i18n = createI18n({
  legacy: false,
  locale: platformClient.locale,
  fallbackLocale: DEFAULT_LOCALE,
  messages: {
    "en-US": enUS,
    "zh-cmn-Hans-CN": zhCmnHansCN,
    "ja-JP": jaJP,
  },
})
