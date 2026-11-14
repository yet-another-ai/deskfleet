<script setup lang="ts">
import { intlLocale, type AppLocale } from "@deskfleet/client/i18n"
import { ArrowUpRight, Download, Smartphone } from "@lucide/vue"
import { useQRCode } from "@vueuse/integrations/useQRCode"
import { computed } from "vue"
import PlatformIcon from "./PlatformIcon.vue"
import { findAndroidDownload, formatSize, releasesPage, type LatestRelease } from "./home-downloads.ts"
import { homeCopy } from "./home-locales.ts"

const props = defineProps<{ locale: AppLocale; release?: LatestRelease; loading: boolean }>()
const t = computed(() => homeCopy[props.locale].install)
const iosUrl = "https://apps.apple.com/us/app/deskfleet/id6833434060"
const androidFile = computed(() => findAndroidDownload(props.release))
const androidUrl = computed(() => androidFile.value?.url ?? releasesPage)
const qrOptions = { width: 264, margin: 4, color: { dark: "#111111", light: "#ffffff" } }
const iosQr = useQRCode(iosUrl, qrOptions)
const androidQr = useQRCode(androidUrl, qrOptions)
const downloads = computed(() => [
  { platform: "ios", title: "iOS", detail: "App Store", href: iosUrl, qr: iosQr.value,
    action: t.value.appStore, scan: t.value.scanIos, status: t.value.iosDevices },
  { platform: "android", title: "Android", detail: "APK · arm64", href: androidUrl.value, qr: androidQr.value,
    action: androidFile.value ? t.value.downloadApk : t.value.releases,
    scan: androidFile.value ? t.value.scanAndroid : t.value.scanReleases,
    status: androidFile.value
      ? `v${props.release!.version} · ${formatSize(androidFile.value.size, intlLocale(props.locale))}`
      : props.loading ? t.value.checkingRelease : t.value.downloadAvailability },
])
</script>

<template>
  <section class="mobile-downloads" aria-labelledby="mobile-downloads-title">
    <h3 id="mobile-downloads-title" class="mobile-downloads__title">{{ t.mobileTitle }}</h3>
    <p class="mobile-downloads__lead">{{ t.mobileLead }}</p>
    <div class="mobile-downloads__grid">
      <article v-for="item in downloads" :key="item.platform" class="mobile-download">
        <div class="mobile-download__info">
          <div class="mobile-download__heading">
            <span class="mobile-download__icon">
              <PlatformIcon v-if="item.platform === 'ios'" platform="macos" />
              <Smartphone v-else :size="22" aria-hidden="true" />
            </span>
            <div>
              <h4>{{ item.title }}</h4>
              <p class="mobile-download__detail">{{ item.detail }}</p>
            </div>
          </div>
          <p class="mobile-download__status" aria-live="polite">{{ item.status }}</p>
          <a class="mobile-download__action" :href="item.href">
            {{ item.action }}
            <Download v-if="item.platform === 'android' && androidFile" :size="16" aria-hidden="true" />
            <ArrowUpRight v-else :size="16" aria-hidden="true" />
          </a>
          <a v-if="item.platform === 'ios'" class="mobile-download__action mobile-download__action--secondary" href="https://testflight.apple.com/join/p35j7ubC">
            {{ t.testFlight }}
            <ArrowUpRight :size="16" aria-hidden="true" />
          </a>
        </div>
        <a class="mobile-download__qr" :href="item.href" :aria-label="item.scan">
          <img v-if="item.qr" :src="item.qr" :alt="item.scan" width="132" height="132" />
        </a>
      </article>
    </div>
  </section>
</template>

<style scoped>
.mobile-downloads { margin-top: 36px; padding-top: 30px; border-top: 1px solid var(--home-edge); }
.mobile-downloads__title { margin: 0; color: var(--home-ink); font-size: 24px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.3; }
.mobile-downloads__lead { margin: 8px 0 20px; color: var(--home-ink-2); font-size: 15px; line-height: 1.6; }
.mobile-downloads__grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.mobile-download { display: grid; grid-template-columns: minmax(0, 1fr) 132px; align-items: center; gap: 16px; padding: 20px; border: 1px solid var(--home-edge); border-radius: 20px; background: var(--home-panel); }
.mobile-download__info { display: flex; min-width: 0; height: 100%; flex-direction: column; align-items: flex-start; }
.mobile-download__heading { display: flex; align-items: center; gap: 10px; }
.mobile-download__heading h4 { margin: 0; color: var(--home-ink); font-size: 18px; font-weight: 700; line-height: 1.4; }
.mobile-download__icon { display: grid; width: 38px; height: 38px; flex: none; place-items: center; border-radius: 12px; background: var(--home-fill); font-size: 22px; }
.mobile-download__detail { margin: 2px 0 0; color: var(--home-ink-2); font-size: 12px; }
.mobile-download__status { margin: 12px 0 16px; color: var(--home-ink-2); font-size: 12px; line-height: 1.5; }
.mobile-download__action { display: inline-flex; align-items: center; gap: 6px; min-height: 36px; margin-top: auto; color: var(--home-ink); font-size: 14px; font-weight: 650; line-height: 1.5; text-decoration: none; }
.mobile-download__action--secondary { min-height: 28px; margin-top: 0; color: var(--home-ink-2); font-size: 13px; font-weight: 500; }
.mobile-download__action svg { flex: none; }
.mobile-download__action:hover { text-decoration: underline; text-underline-offset: 4px; }
.mobile-download__qr { display: block; width: 132px; height: 132px; overflow: hidden; border-radius: 12px; background: #fff; }
.mobile-download__qr img { display: block; width: 100%; height: 100%; }
.mobile-download__action:focus-visible, .mobile-download__qr:focus-visible { outline: 2px solid var(--ui-color-focus); outline-offset: 4px; }
@media (max-width: 760px) {
  .mobile-downloads__grid { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 360px) {
  .mobile-download { gap: 12px; padding: 16px; }
}
</style>
