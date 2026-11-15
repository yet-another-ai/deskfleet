<script setup lang="ts">
import DefaultTheme from "vitepress/theme-without-fonts"
import { useData, useRouter } from "vitepress"
import { computed, onMounted, watch } from "vue"
import { useI18n } from "vue-i18n"
import { usePreferredLanguages } from "@vueuse/core"
import { resolveSurfaceGoogleTagIds } from "@deskfleet/client/analytics-config"
import { resolveAppLocale, type AppLocale } from "@deskfleet/client/i18n"
import { appendAttributionParams } from "@deskfleet/client/marketing-attribution"
import {
  initializeAnalytics,
  setSiteTelemetryEnabled,
  trackAcquisitionConversion,
  trackMarketingEvent,
  userTelemetryConsent,
} from "@deskfleet/components/services/analytics.ts"
import { firstVisitLanguageRedirect } from "../preferred-language"
import MarketingConsentBanner from "./MarketingConsentBanner.vue"
const { Layout } = DefaultTheme
const { lang } = useData()
const { locale } = useI18n()
const router = useRouter()
const languages = usePreferredLanguages()
const currentLocale = computed<AppLocale>(() => resolveAppLocale([lang.value]))
const getStartedHref = computed(() =>
  appendAttributionParams("https://deskfleet.yetanother.ai", userTelemetryConsent.value),
)
watch(lang, value => { locale.value = resolveAppLocale([value]) }, { immediate: true })
onMounted(() => {
  setSiteTelemetryEnabled(true)
  const googleIds = resolveSurfaceGoogleTagIds("docs", import.meta.env)
  initializeAnalytics({
    clientKey: import.meta.env.VITE_STATSIG_CLIENT_KEY,
    environment: import.meta.env.VITE_STATSIG_ENVIRONMENT?.trim() || import.meta.env.MODE,
    platform: "docs",
    gtmId: googleIds.gtmId,
    gaMeasurementId: googleIds.gaMeasurementId,
    googleAdsId: googleIds.googleAdsId,
    googleAdsInstallLabel: googleIds.googleAdsInstallLabel,
    requireConsent: true,
  })
  const target = firstVisitLanguageRedirect(window, languages.value)
  if (target) void router.go(target, { replace: true })
  trackMarketingEvent("marketing_page_viewed", { path: router.route.path })
})
watch(() => router.route.path, path => {
  trackMarketingEvent("marketing_page_viewed", { path })
})
</script>

<template>
  <Layout>
    <template #nav-bar-content-after>
      <a
        class="get-started"
        :href="getStartedHref"
        @click="trackAcquisitionConversion('marketing_get_started_clicked', { destination: 'cloud' })"
      >Get Started</a>
    </template>
    <template #layout-bottom>
      <MarketingConsentBanner :locale="currentLocale" />
    </template>
  </Layout>
</template>

<style scoped>
.get-started {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  height: 36px;
  margin-inline-start: 16px;
  padding: 0 16px;
  border-radius: 8px;
  background: var(--vp-button-brand-bg);
  color: var(--vp-button-brand-text);
  font-size: 14px;
  font-weight: 600;
}

.get-started:hover {
  background: var(--vp-button-brand-hover-bg);
  color: var(--vp-button-brand-hover-text);
}

@media (max-width: 480px) {
  .get-started {
    margin-inline-start: 8px;
    padding-inline: 12px;
  }
}
</style>
