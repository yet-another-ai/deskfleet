<script setup lang="ts">
import { intlLocale, type AppLocale } from "@deskfleet/client/i18n"
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import { useAsyncState } from "@vueuse/core"
import { withBase } from "vitepress"
import { Check, Copy, Terminal } from "@lucide/vue"
import DownloadCard from "./DownloadCard.vue"
import PlatformIcon from "./PlatformIcon.vue"
import SegmentedControl from "./SegmentedControl.vue"
import { useRevealOnce } from "./home-motion.ts"
import { fetchLatestRelease, findDownload, formatSize, releasesPage, type InstallMode, type InstallPlatform } from "./home-downloads.ts"
import { homeCopy, homeLocalePath } from "./home-locales.ts"

const props = withDefaults(defineProps<{ locale?: AppLocale }>(), { locale: "en-US" })
const t = computed(() => homeCopy[props.locale].install)
const root = ref<HTMLElement>()
const shown = useRevealOnce(root, 0.15)
const mode = ref<InstallMode>("desktop")
const platform = ref<InstallPlatform>("macos")
const copied = ref(false)
const copyError = ref(false)
const platforms: { value: InstallPlatform; label: string }[] = [{ value: "macos", label: "macOS" }, { value: "windows", label: "Windows" }, { value: "linux", label: "Linux" }]
const modes = computed<{ value: InstallMode; label: string }[]>(() => [{ value: "desktop", label: t.value.desktop }, { value: "headless", label: t.value.headless }])
const command = computed(() => mode.value === "desktop" ? "mise run desktop:dev" : `mise run daemon:pack\n${platform.value === "windows" ? ".\\apps\\daemon\\dist\\deskfleet-daemon.exe" : "./apps/daemon/dist/deskfleet-daemon"}`)
const guide = computed(() => withBase(homeLocalePath(props.locale, "/guide/getting-started")))
const { state: release, isLoading, executeImmediate: loadRelease } = useAsyncState(fetchLatestRelease, undefined, { immediate: false })
const formatLocale = computed(() => intlLocale(props.locale))
const releaseSummary = computed(() => release.value && `v${release.value.version} · ${new Intl.DateTimeFormat(formatLocale.value, { dateStyle: "medium" }).format(new Date(release.value.publishedAt))}`)
const downloadTitle = computed(() => {
  const product = mode.value === "desktop" ? "DeskFleet" : t.value.daemon
  const system = platforms.find(item => item.value === platform.value)!.label
  return t.value.downloadTitle.replace("{product}", product).replace("{system}", system)
})
const packageFormat = computed(() => {
  if (mode.value === "headless") return t.value.tarArchive
  if (platform.value === "macos") return t.value.dmgInstaller
  if (platform.value === "windows") return t.value.installer
  return "AppImage"
})
const primary = computed(() => {
  const file = findDownload(release.value, mode.value, platform.value, "x64")
  return {
    title: downloadTitle.value,
    detail: `${packageFormat.value} · ${platform.value === "macos" ? "Apple Silicon" : "x64"}`,
    href: file?.url ?? releasesPage,
    file: file && `${file.name} · ${formatSize(file.size, formatLocale.value)}`,
  }
})
const alternatives = computed(() => {
  if (platform.value === "linux") {
    const file = findDownload(release.value, mode.value, "linux", "arm64")
    return [{
      title: downloadTitle.value,
      detail: `${packageFormat.value} · arm64`,
      href: file?.url ?? releasesPage,
      file: file && formatSize(file.size, formatLocale.value),
    }]
  }
  if (mode.value === "desktop" && platform.value === "macos") {
    const file = findDownload(release.value, "desktop", "macos", "x64", "archive")
    return [{
      title: t.value.zipArchive,
      detail: "Apple Silicon",
      href: file?.url ?? releasesPage,
      file: file && formatSize(file.size, formatLocale.value),
    }]
  }
  return []
})
let timer: ReturnType<typeof setTimeout> | undefined
onMounted(() => {
  void loadRelease()
  if (/Windows/i.test(navigator.userAgent)) platform.value = "windows"
  else if (/Linux/i.test(navigator.userAgent) && !/Android/i.test(navigator.userAgent)) platform.value = "linux"
})
onBeforeUnmount(() => clearTimeout(timer))
async function copy() {
  copyError.value = false
  try { await navigator.clipboard.writeText(command.value); copied.value = true }
  catch { copyError.value = true; return }
  clearTimeout(timer)
  timer = setTimeout(() => { copied.value = false }, 1600)
}
</script>

<template>
  <section id="get-deskfleet" ref="root" class="install reveal" :class="{ 'is-shown': shown }">
    <div class="install__inner">
      <img class="install__mark reveal-line" style="--line: 0" :src="withBase('/logo.png')" alt="" width="64" height="64" />
      <p class="home-kicker reveal-line" style="--line: 1">{{ t.kicker }}</p>
      <h2 class="home-heading reveal-line" style="--line: 2">{{ t.title }}</h2>
      <p class="install__lead reveal-line" style="--line: 3">{{ t.lead }}</p>
      <div class="install__controls reveal-line" style="--line: 4">
        <SegmentedControl v-model="mode" :options="modes" :label="t.mode" />
        <div class="install__row">
          <SegmentedControl v-model="platform" :options="platforms" size="small" :label="t.platform">
            <template #icon="{ value }"><PlatformIcon :platform="value" /></template>
          </SegmentedControl>
          <span class="install__release" :class="{ 'is-ready': releaseSummary }" aria-live="polite">
            <i aria-hidden="true" />
            {{ releaseSummary ? `${t.latestRelease} · ${releaseSummary}` : isLoading ? t.checkingRelease : t.downloadAvailability }}
          </span>
        </div>
      </div>
      <Transition name="install-swap" mode="out-in">
        <div :key="`${mode}-${platform}`" class="install__target">
          <DownloadCard primary :href="primary.href" :title="primary.title" :detail="primary.detail" :file="primary.file" :platform="platform" :action="primary.file ? t.download : t.releases" />
          <div v-if="alternatives.length" class="install__alternatives">
            <DownloadCard v-for="download in alternatives" :key="download.detail" :href="download.href" :title="download.title" :detail="download.detail" :file="download.file" :platform="platform" :action="download.file ? t.download : t.releases" />
          </div>
          <div class="install__command">
            <div class="install__command-head"><span><Terminal :size="14" aria-hidden="true" />{{ t.source }}</span><button type="button" :aria-label="t.copyCommand" @click="copy"><Check v-if="copied" :size="15" /><Copy v-else :size="15" />{{ copied ? t.copied : t.copy }}</button></div>
            <pre><code>{{ command }}</code></pre>
          </div>
          <p v-if="copyError" class="install__note" role="status">{{ t.copyError }}</p>
          <p class="install__note">{{ t.note }}</p>
        </div>
      </Transition>
      <p class="install__links reveal-line" style="--line: 5"><a :href="guide">{{ t.guide }} →</a><a :href="releasesPage">{{ t.allDownloads }} →</a><a href="https://github.com/yet-another-ai/deskfleet">{{ t.repository }} →</a></p>
    </div>
  </section>
</template>

<style scoped>
.install { padding: clamp(96px, 12vw, 150px) 24px clamp(80px, 10vw, 120px); scroll-margin-top: calc(var(--vp-nav-height) - 40px); }
.install__inner { max-width: 780px; margin: 0 auto; }
.install__mark { margin-bottom: 32px; border-radius: 16px; box-shadow: 0 14px 30px -12px var(--home-shadow); }
.install__lead { max-width: 580px; margin: 14px 0 32px; color: var(--home-ink-2); font-size: 18px; line-height: 1.55; }
.install__controls { display: grid; justify-items: start; gap: 10px; margin-bottom: 14px; }
.install__controls > :first-child { width: 100%; }
.install__row { display: flex; width: 100%; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 16px; }
.install__release { display: inline-flex; align-items: center; gap: 8px; min-height: 20px; color: var(--home-ink-2); font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
.install__release i { width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--home-ink-2); opacity: 0.4; transition: background 300ms ease, opacity 300ms ease; }
.install__release.is-ready i { background: var(--ui-color-success); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ui-color-success) 22%, transparent); opacity: 1; }
.install__target { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; }
.install__alternatives { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
.install__command { overflow: hidden; border: 1px solid var(--home-edge); border-radius: 16px; background: var(--home-panel); }
.install__command-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--home-edge); color: var(--home-ink-2); font-size: 12px; }
.install__command-head span, .install__command-head button { display: inline-flex; align-items: center; gap: 7px; }
.install__command-head button { cursor: pointer; color: var(--home-ink); flex: none; }
.install__command pre { margin: 0; padding: 18px; overflow-x: auto; font-family: var(--vp-font-family-mono); font-size: 13px; line-height: 1.9; }
.install__note { margin: 0 2px; color: var(--home-ink-2); font-size: 12px; line-height: 1.7; }
.install__links { display: flex; flex-wrap: wrap; gap: 24px; margin-top: 26px; font-size: 14px; font-weight: 650; }
.install__links a:hover { text-decoration: underline; text-underline-offset: 4px; }
.install-swap-enter-active, .install-swap-leave-active { transition: opacity 160ms ease, transform 160ms ease; }
.install-swap-enter-from, .install-swap-leave-to { opacity: 0; transform: translateY(5px); }
@media (max-width: 560px) { .install { padding-inline: 16px; } .install__row > :first-child { width: 100%; } }
@media (max-width: 360px) {
  .install__controls :deep(.segmented--large .segmented__option) { padding-inline: 12px; font-size: 14px; }
  .install__controls :deep(.segmented--small .segmented__option) { padding-inline: 10px; gap: 6px; }
}
@media (prefers-reduced-motion: reduce) { .install-swap-enter-active, .install-swap-leave-active, .install__release i { transition: none; } }
</style>
