<script setup lang="ts">
import { resolveSurfaceGoogleTagIds } from "@deskfleet/client/analytics-config"
import type { AppLocale } from "@deskfleet/client/i18n"
import { readStoredTelemetryConsent } from "@deskfleet/client/marketing-attribution"
import { setUserTelemetryConsent } from "@deskfleet/components/services/analytics.ts"
import { computed, onMounted, ref } from "vue"

const props = withDefaults(defineProps<{ locale?: AppLocale; forceVisible?: boolean }>(), {
  locale: "en-US",
  forceVisible: false,
})

const visible = ref(false)

const copy: Record<AppLocale, {
  message: string
  privacyLabel: string
  privacyHref: string
  accept: string
  decline: string
}> = {
  "en-US": {
    message: "We use optional analytics and campaign attribution to measure downloads and improve DeskFleet. Prompts, code, and files are never collected.",
    privacyLabel: "Privacy policy",
    privacyHref: "/privacy",
    accept: "Accept",
    decline: "Decline",
  },
  "zh-cmn-Hans-CN": {
    message: "我们使用可选的统计与推广归因来衡量下载转化并改进 DeskFleet。绝不收集提示词、代码或文件内容。",
    privacyLabel: "隐私政策",
    privacyHref: "/zh/privacy",
    accept: "同意",
    decline: "拒绝",
  },
  "ja-JP": {
    message: "ダウンロード計測と DeskFleet の改善のため、任意の分析とキャンペーンアトリビューションを使用しています。プロンプト、コード、ファイルは一切収集されません。",
    privacyLabel: "プライバシーポリシー",
    privacyHref: "/ja/privacy",
    accept: "同意する",
    decline: "拒否する",
  },
}

const t = computed(() => copy[props.locale] ?? copy["en-US"])

function hasConfiguredTelemetry(): boolean {
  if (props.forceVisible) return true
  const env = import.meta.env
  const googleIds = resolveSurfaceGoogleTagIds("docs", env)
  return Boolean(
    googleIds.gtmId
    || googleIds.gaMeasurementId
    || googleIds.googleAdsId
    || env.VITE_STATSIG_CLIENT_KEY?.trim(),
  )
}

onMounted(() => {
  if (!hasConfiguredTelemetry()) return
  visible.value = readStoredTelemetryConsent() === undefined
})

function choose(consented: boolean): void {
  setUserTelemetryConsent(consented)
  visible.value = false
}
</script>

<template>
  <aside
    v-if="visible"
    class="consent-banner"
    role="region"
    aria-label="Analytics consent"
    data-consent-banner
  >
    <p class="consent-banner__text">
      {{ t.message }}
      <a class="consent-banner__link" :href="t.privacyHref">{{ t.privacyLabel }}</a>
    </p>
    <div class="consent-banner__actions">
      <button type="button" class="consent-banner__button" data-consent-decline @click="choose(false)">
        {{ t.decline }}
      </button>
      <button type="button" class="consent-banner__button consent-banner__button--primary" data-consent-accept @click="choose(true)">
        {{ t.accept }}
      </button>
    </div>
  </aside>
</template>

<style scoped>
.consent-banner {
  position: fixed;
  right: 16px;
  bottom: 16px;
  left: 16px;
  z-index: 50;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px 20px;
  max-width: 880px;
  margin: 0 auto;
  padding: 12px 16px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 14px;
  background: color-mix(in srgb, var(--vp-c-bg-elv) 92%, transparent);
  color: var(--vp-c-text-1);
  box-shadow: 0 14px 36px -16px rgba(0, 0, 0, 0.28);
  backdrop-filter: blur(16px);
}

.consent-banner__text {
  margin: 0;
  flex: 1 1 360px;
  color: var(--vp-c-text-2);
  font-size: 13px;
  line-height: 1.5;
}

.consent-banner__link {
  margin-inline-start: 6px;
  color: var(--vp-c-text-1);
  font-weight: 500;
  text-decoration: underline;
  text-underline-offset: 3px;
}

.consent-banner__actions {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
}

.consent-banner__button {
  height: 32px;
  padding: 0 14px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.consent-banner__button:hover {
  border-color: var(--vp-c-text-3);
}

.consent-banner__button--primary {
  border-color: transparent;
  background: var(--vp-button-brand-bg);
  color: var(--vp-button-brand-text);
}

.consent-banner__button--primary:hover {
  background: var(--vp-button-brand-hover-bg);
  color: var(--vp-button-brand-hover-text);
}
</style>
