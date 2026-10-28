<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import { useAsyncState } from "@vueuse/core"
import { withBase } from "vitepress"
import { Check, Copy, Terminal } from "@lucide/vue"
import DownloadCard from "./DownloadCard.vue"
import PlatformIcon from "./PlatformIcon.vue"
import SegmentedControl from "./SegmentedControl.vue"
import { useRevealOnce } from "./home-motion.ts"
import { fetchLatestRelease, findDownload, formatSize, releasesPage, type InstallMode, type InstallPlatform } from "./home-downloads.ts"
const props = withDefaults(defineProps<{ chinese?: boolean }>(), { chinese: false })
const root = ref<HTMLElement>()
const shown = useRevealOnce(root, 0.15)
const mode = ref<InstallMode>("desktop")
const platform = ref<InstallPlatform>("macos")
const copied = ref(false)
const copyError = ref(false)
const platforms: { value: InstallPlatform; label: string }[] = [{ value: "macos", label: "macOS" }, { value: "windows", label: "Windows" }, { value: "linux", label: "Linux" }]
const modes = computed<{ value: InstallMode; label: string }[]>(() => [{ value: "desktop", label: props.chinese ? "桌面应用" : "Desktop app" }, { value: "headless", label: props.chinese ? "无桌面机器" : "Headless machine" }])
const command = computed(() => mode.value === "desktop" ? "mise run desktop:dev" : `mise run daemon:pack\n${platform.value === "windows" ? ".\\apps\\daemon\\dist\\deskfleet-daemon.exe" : "./apps/daemon/dist/deskfleet-daemon"}`)
const guide = computed(() => withBase(`${props.chinese ? "/zh" : ""}/guide/getting-started`))
const { state: release, isLoading, executeImmediate: loadRelease } = useAsyncState(fetchLatestRelease, undefined, { immediate: false })
const locale = computed(() => props.chinese ? "zh-CN" : "en-US")
const releaseSummary = computed(() => release.value && `v${release.value.version} · ${new Intl.DateTimeFormat(locale.value, { dateStyle: "medium" }).format(new Date(release.value.publishedAt))}`)
const downloadTitle = computed(() => {
  const product = mode.value === "desktop" ? "DeskFleet" : "DeskFleet daemon"
  const system = platforms.find(item => item.value === platform.value)?.label
  return props.chinese ? `${product} ${system} 版` : `${product} for ${system}`
})
const packageFormat = computed(() => {
  if (mode.value === "headless") return props.chinese ? "TAR.GZ 压缩包" : "TAR.GZ archive"
  if (platform.value === "macos") return props.chinese ? "DMG 安装包" : "DMG installer"
  if (platform.value === "windows") return props.chinese ? "安装程序" : "Installer"
  return "AppImage"
})
const primary = computed(() => {
  const file = findDownload(release.value, mode.value, platform.value, "x64")
  return {
    title: downloadTitle.value,
    detail: `${packageFormat.value} · ${platform.value === "macos" ? "Apple Silicon" : "x64"}`,
    href: file?.url ?? releasesPage,
    file: file && `${file.name} · ${formatSize(file.size, locale.value)}`,
  }
})
const alternatives = computed(() => {
  if (platform.value === "linux") {
    const file = findDownload(release.value, mode.value, "linux", "arm64")
    return [{
      title: downloadTitle.value,
      detail: `${packageFormat.value} · arm64`,
      href: file?.url ?? releasesPage,
      file: file && formatSize(file.size, locale.value),
    }]
  }
  if (mode.value === "desktop" && platform.value === "macos") {
    const file = findDownload(release.value, "desktop", "macos", "x64", "archive")
    return [{
      title: props.chinese ? "ZIP 压缩包" : "ZIP archive",
      detail: "Apple Silicon",
      href: file?.url ?? releasesPage,
      file: file && formatSize(file.size, locale.value),
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
      <p class="home-kicker reveal-line" style="--line: 1">{{ chinese ? '给你的 Agent，一个共同的工作现场' : 'A place for all your agents' }}</p>
      <h2 class="home-heading reveal-line" style="--line: 2">{{ chinese ? '让它们，一起工作。' : 'Bring your agents together.' }}</h2>
      <p class="install__lead reveal-line" style="--line: 3">{{ chinese ? '从你的电脑开始，再连接团队的其他机器。' : 'Start with your computer. Bring the rest of your team along.' }}</p>
      <div class="install__controls reveal-line" style="--line: 4">
        <SegmentedControl v-model="mode" :options="modes" :label="chinese ? '运行方式' : 'How to run DeskFleet'" />
        <div class="install__row">
          <SegmentedControl v-model="platform" :options="platforms" size="small" :label="chinese ? '操作系统' : 'Operating system'">
            <template #icon="{ value }"><PlatformIcon :platform="value" /></template>
          </SegmentedControl>
          <span class="install__release" :class="{ 'is-ready': releaseSummary }" aria-live="polite">
            <i aria-hidden="true" />
            {{ releaseSummary ? `${chinese ? '最新版本' : 'Latest release'} · ${releaseSummary}` : isLoading ? (chinese ? '正在查询最新版本…' : 'Checking the latest release…') : (chinese ? '请前往发布页下载' : 'Downloads available on the release page') }}
          </span>
        </div>
      </div>
      <Transition name="install-swap" mode="out-in">
        <div :key="`${mode}-${platform}`" class="install__target">
          <DownloadCard primary :href="primary.href" :title="primary.title" :detail="primary.detail" :file="primary.file" :platform="platform" :action="primary.file ? (chinese ? '下载' : 'Download') : (chinese ? '查看发布版本' : 'View releases')" />
          <div v-if="alternatives.length" class="install__alternatives">
            <DownloadCard v-for="download in alternatives" :key="download.detail" :href="download.href" :title="download.title" :detail="download.detail" :file="download.file" :platform="platform" :action="download.file ? (chinese ? '下载' : 'Download') : (chinese ? '查看发布版本' : 'View releases')" />
          </div>
          <div class="install__command">
            <div class="install__command-head"><span><Terminal :size="14" aria-hidden="true" />{{ chinese ? '完成开发环境配置后，从源码运行' : 'Run from source after setting up your environment' }}</span><button type="button" :aria-label="chinese ? '复制命令' : 'Copy command'" @click="copy"><Check v-if="copied" :size="15" /><Copy v-else :size="15" />{{ copied ? (chinese ? '已复制' : 'Copied') : (chinese ? '复制' : 'Copy') }}</button></div>
            <pre><code>{{ command }}</code></pre>
          </div>
          <p v-if="copyError" class="install__note" role="status">{{ chinese ? '请选中上方命令手动复制。' : 'Select the command above to copy it manually.' }}</p>
          <p class="install__note">{{ chinese ? '需要已安装并登录的 Agent CLI。开发环境配置、机器注册和平台要求请查看入门指南。' : 'Bring an installed, authenticated agent CLI. The setup guide covers the development environment, enrollment, and platform requirements.' }}</p>
        </div>
      </Transition>
      <p class="install__links reveal-line" style="--line: 5"><a :href="guide">{{ chinese ? '入门指南' : 'Setup guide' }} →</a><a :href="releasesPage">{{ chinese ? '所有下载' : 'All downloads' }} →</a><a href="https://github.com/yet-another-ai/deskfleet">{{ chinese ? '查看完整源码' : 'Explore the source' }} →</a></p>
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
