<script setup lang="ts">
import {
  ArrowLeft,
  ArrowRight,
  CodeXml,
  ExternalLink,
  Globe,
  LoaderCircle,
  RotateCw,
} from "@lucide/vue"
import { watchImmediate } from "@vueuse/core"
import { computed, onScopeDispose, ref, useTemplateRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import { useFileTarget } from "../../composables/useFileTarget.ts"
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import {
  buildActualPreviewOrigin,
  buildActualPreviewUrl,
  extractLogicalPath,
  formatLogicalPreviewUrl,
  formatWebPreviewTabTitle,
  parseWebPreviewInput,
  type WebPreviewTarget,
} from "../../services/web-preview.ts"
import ErrorNotice from "../common/ErrorNotice.vue"
import UiButton from "../common/UiButton.vue"

interface ElectronWebviewElement extends HTMLElement {
  src: string
  loadURL?(url: string): Promise<void>
  canGoBack?(): boolean
  canGoForward?(): boolean
  goBack?(): void
  goForward?(): void
  reload?(): void
  getWebContentsId?(): number
}

const WEB_PREVIEW_PARTITION = "temp:deskfleet-web-preview"
const QUICK_PORTS = [3000, 5173, 8080] as const

const props = defineProps<{
  sessionId: string
  active: boolean
  initialTarget?: WebPreviewTarget | null
}>()
const emit = defineEmits<{
  title: [value: string]
  change: [target: WebPreviewTarget | null]
}>()

const { t } = useI18n()
const client = usePlatformClient()
const fleet = useFleetStore()

const webviewHost = useTemplateRef<HTMLElement>("webviewHost")
const addressInputEl = useTemplateRef<HTMLInputElement>("addressInputEl")
const everActivated = ref(props.active)
watchImmediate(() => props.active, active => {
  if (active) everActivated.value = true
})

const committedTarget = ref<WebPreviewTarget | null>(props.initialTarget ?? null)
const addressInput = ref(committedTarget.value ? formatLogicalPreviewUrl(committedTarget.value) : "")
const emptyInput = ref("")
const addressError = ref<string | null>(null)
const connectError = ref<string | null>(null)
const loadError = ref<string | null>(null)
const connecting = ref(false)
const pageLoading = ref(false)
const pageTitle = ref("")
const resolvedOrigin = ref<string | null>(null)
const retryNonce = ref(0)

const isDesktopWebview = computed(() => Boolean(client.webPreview))
const location = computed(() => fleet.findSession(props.sessionId))
const machine = computed(() => location.value?.machine)
const fileTarget = useFileTarget(() => location.value?.machine.id)
const useDirectLocal = computed(() => Boolean(machine.value?.local && client.platform !== "web" && !client.mobile))
const remoteTarget = computed(() => {
  if (fileTarget.value?.kind === "machine") {
    return { teamId: fileTarget.value.teamId, machineId: fileTarget.value.machineId }
  }
  if (fleet.catalog?.teamId && machine.value) {
    return { teamId: fleet.catalog.teamId, machineId: machine.value.id }
  }
  return undefined
})
const machineOffline = computed(() => Boolean(committedTarget.value && machine.value && !machine.value.local && !machine.value.online))

const webviewCanGoBack = ref(false)
const webviewCanGoForward = ref(false)
const guestWebContentsId = ref<number | null>(null)
let webviewEl: ElectronWebviewElement | null = null
let webviewDomReady = false

const mobileHistory = ref<string[]>([])
const mobileHistoryIndex = ref(-1)
const iframeKey = ref(0)

const mobileCurrentPath = computed(() =>
  mobileHistoryIndex.value >= 0 ? mobileHistory.value[mobileHistoryIndex.value] ?? "/" : (committedTarget.value?.path ?? "/"),
)
const actualUrl = computed(() =>
  resolvedOrigin.value && committedTarget.value
    ? buildActualPreviewUrl(resolvedOrigin.value, isDesktopWebview.value ? committedTarget.value.path : mobileCurrentPath.value)
    : undefined,
)
const canGoBack = computed(() =>
  isDesktopWebview.value ? webviewCanGoBack.value : mobileHistoryIndex.value > 0,
)
const canGoForward = computed(() =>
  isDesktopWebview.value
    ? webviewCanGoForward.value
    : mobileHistoryIndex.value >= 0 && mobileHistoryIndex.value < mobileHistory.value.length - 1,
)
const canReload = computed(() => Boolean(resolvedOrigin.value && committedTarget.value))
const canOpenExternal = computed(() => Boolean(actualUrl.value))
const canOpenDevTools = computed(() => Boolean(isDesktopWebview.value && guestWebContentsId.value !== null))
const committedLogicalUrl = computed(() => (committedTarget.value ? formatLogicalPreviewUrl(committedTarget.value) : ""))
const addressDirty = computed(() => addressInput.value.trim() !== committedLogicalUrl.value)

function emitTitle(): void {
  emit("title", formatWebPreviewTabTitle(committedTarget.value, pageTitle.value, t("webPreview.title")))
}

watch(
  [() => committedTarget.value?.displayHost, () => committedTarget.value?.targetPort, pageTitle],
  () => emitTitle(),
  { immediate: true },
)

const endpointKey = computed(() => {
  if (!everActivated.value || !committedTarget.value || !machine.value) return null
  if (!machine.value.local && !machine.value.online) return null
  if (!useDirectLocal.value && !remoteTarget.value) return null
  return JSON.stringify([
    useDirectLocal.value ? "local" : remoteTarget.value!.teamId,
    machine.value.id,
    useDirectLocal.value,
    committedTarget.value.targetHost,
    committedTarget.value.targetPort,
    retryNonce.value,
  ])
})

let endpointRevision = 0
let activeForwardId: string | undefined
watchImmediate(endpointKey, (key, _previous, onCleanup) => {
  const revision = ++endpointRevision
  let cancelled = false
  let forwardId: string | undefined
  let grantId: string | undefined
  activeForwardId = undefined

  resolvedOrigin.value = null
  connectError.value = null
  loadError.value = null
  pageTitle.value = ""
  pageLoading.value = false
  webviewCanGoBack.value = false
  webviewCanGoForward.value = false
  guestWebContentsId.value = null
  mobileHistory.value = []
  mobileHistoryIndex.value = -1

  onCleanup(() => {
    cancelled = true
    if (forwardId) {
      const id = forwardId
      if (activeForwardId === id) activeForwardId = undefined
      forwardId = undefined
      void client.ports?.stop(id).catch(() => {})
    }
    if (grantId) {
      const id = grantId
      grantId = undefined
      void client.webPreview?.revokeOrigin(id).catch(() => {})
    }
  })

  if (!key || !committedTarget.value || !machine.value) {
    connecting.value = false
    return
  }

  const target = committedTarget.value
  const direct = useDirectLocal.value
  const forwardTarget = remoteTarget.value
  connecting.value = true

  void (async () => {
    try {
      let origin: string
      if (direct) {
        origin = buildActualPreviewOrigin(target.targetHost, target.targetPort)
      } else {
        if (!client.ports || !forwardTarget) throw new Error(t("webPreview.unavailable"))
        const forward = await client.ports.start({
          target: forwardTarget,
          targetHost: target.targetHost,
          targetPort: target.targetPort,
        })
        if (cancelled || revision !== endpointRevision) {
          void client.ports.stop(forward.id).catch(() => {})
          return
        }
        forwardId = forward.id
        activeForwardId = forward.id
        origin = buildActualPreviewOrigin("127.0.0.1", forward.localPort)
      }

      if (client.webPreview) {
        const createdGrant = await client.webPreview.allowOrigin(origin)
        if (cancelled || revision !== endpointRevision) {
          void client.webPreview.revokeOrigin(createdGrant).catch(() => {})
          return
        }
        grantId = createdGrant
      }

      if (cancelled || revision !== endpointRevision) return
      if (!isDesktopWebview.value) {
        mobileHistory.value = [target.path]
        mobileHistoryIndex.value = 0
      }
      resolvedOrigin.value = origin
    } catch (reason) {
      if (cancelled || revision !== endpointRevision) return
      connectError.value = reason instanceof Error ? reason.message : String(reason)
    } finally {
      if (!cancelled && revision === endpointRevision) connecting.value = false
    }
  })()
})

function syncWebviewNavigation(el: ElectronWebviewElement): void {
  webviewCanGoBack.value = el.canGoBack?.() ?? false
  webviewCanGoForward.value = el.canGoForward?.() ?? false
}

function syncPathFromGuest(rawUrl: string): void {
  const origin = resolvedOrigin.value
  const current = committedTarget.value
  if (!origin || !current) return
  const nextPath = extractLogicalPath(rawUrl, origin)
  if (!nextPath || nextPath === current.path) return
  const updated: WebPreviewTarget = { ...current, path: nextPath }
  committedTarget.value = updated
  if (document.activeElement !== addressInputEl.value) {
    addressInput.value = formatLogicalPreviewUrl(updated)
  }
  emit("change", updated)
}

watch(
  [webviewHost, resolvedOrigin, isDesktopWebview],
  ([host, origin, useWebview], _previous, onCleanup) => {
    if (!useWebview || !host || !origin) return
    const el = document.createElement("webview") as unknown as ElectronWebviewElement
    webviewEl = el
    webviewDomReady = false
    // Partition must be assigned before src and before DOM attachment.
    el.setAttribute("partition", WEB_PREVIEW_PARTITION)
    el.className = "min-h-0 h-full w-full flex-1 border-0 bg-white"
    el.style.width = "100%"
    el.style.height = "100%"
    el.style.flex = "1 1 auto"
    el.style.border = "0"

    const onDomReady = () => {
      webviewDomReady = true
      guestWebContentsId.value = el.getWebContentsId?.() ?? null
      syncWebviewNavigation(el)
    }
    const onStartLoading = () => {
      pageLoading.value = true
      loadError.value = null
    }
    const onStopLoading = () => {
      pageLoading.value = false
      syncWebviewNavigation(el)
    }
    const onNavigate = (event: Event) => {
      const navEvent = event as Event & { url?: string; isMainFrame?: boolean }
      if (navEvent.isMainFrame === false || !navEvent.url) return
      syncWebviewNavigation(el)
      syncPathFromGuest(navEvent.url)
    }
    const onTitleUpdated = (event: Event) => {
      const titleEvent = event as Event & { title?: string }
      pageTitle.value = titleEvent.title ?? ""
    }
    const onFailLoad = (event: Event) => {
      const failEvent = event as Event & { errorCode?: number; errorDescription?: string; isMainFrame?: boolean }
      if (failEvent.isMainFrame === false || failEvent.errorCode === -3) return
      pageLoading.value = false
      loadError.value = failEvent.errorDescription?.trim() || t("webPreview.loadFailed")
    }

    el.addEventListener("dom-ready", onDomReady)
    el.addEventListener("did-start-loading", onStartLoading)
    el.addEventListener("did-stop-loading", onStopLoading)
    el.addEventListener("did-navigate", onNavigate)
    el.addEventListener("did-navigate-in-page", onNavigate)
    el.addEventListener("page-title-updated", onTitleUpdated)
    el.addEventListener("did-fail-load", onFailLoad)

    const initialUrl = buildActualPreviewUrl(origin, committedTarget.value?.path ?? "/")
    el.setAttribute("src", initialUrl)
    host.replaceChildren(el)

    onCleanup(() => {
      el.removeEventListener("dom-ready", onDomReady)
      el.removeEventListener("did-start-loading", onStartLoading)
      el.removeEventListener("did-stop-loading", onStopLoading)
      el.removeEventListener("did-navigate", onNavigate)
      el.removeEventListener("did-navigate-in-page", onNavigate)
      el.removeEventListener("page-title-updated", onTitleUpdated)
      el.removeEventListener("did-fail-load", onFailLoad)
      host.replaceChildren()
      if (webviewEl === el) webviewEl = null
      webviewDomReady = false
      guestWebContentsId.value = null
    })
  },
  { immediate: true, flush: "post" },
)

onScopeDispose(() => {
  endpointRevision++
  activeForwardId = undefined
})

async function isActiveForwardRetired(): Promise<boolean> {
  if (useDirectLocal.value || !client.ports || !activeForwardId) return false
  const currentId = activeForwardId
  try {
    const active = await client.ports.list()
    return !active.some(entry => entry.id === currentId)
  } catch {
    return false
  }
}

function reloadCurrentTarget(): void {
  if (isDesktopWebview.value) webviewEl?.reload?.()
  else iframeKey.value++
}

function navigateResolvedUrl(url: string, nextPath: string): void {
  if (isDesktopWebview.value && webviewEl) {
    if (webviewDomReady && webviewEl.loadURL) void webviewEl.loadURL(url)
    else webviewEl.setAttribute("src", url)
  } else if (!isDesktopWebview.value) {
    mobileHistory.value = [...mobileHistory.value.slice(0, mobileHistoryIndex.value + 1), nextPath]
    mobileHistoryIndex.value = mobileHistory.value.length - 1
    iframeKey.value++
  }
}

function applyTarget(raw: string): void {
  const parsed = parseWebPreviewInput(raw)
  if (!parsed) {
    addressError.value = t("webPreview.invalidAddress")
    return
  }
  const previous = committedTarget.value
  const sameOrigin = Boolean(
    previous
    && previous.targetHost === parsed.targetHost
    && previous.targetPort === parsed.targetPort
    && resolvedOrigin.value,
  )
  committedTarget.value = parsed
  addressInput.value = formatLogicalPreviewUrl(parsed)
  emptyInput.value = ""
  addressError.value = null
  loadError.value = null
  emit("change", parsed)

  if (sameOrigin && resolvedOrigin.value) {
    const nextActualUrl = buildActualPreviewUrl(resolvedOrigin.value, parsed.path)
    if (!useDirectLocal.value && activeForwardId) {
      const currentForwardId = activeForwardId
      void isActiveForwardRetired().then(retired => {
        if (activeForwardId !== currentForwardId || !resolvedOrigin.value) return
        if (retired) {
          retryNonce.value++
          return
        }
        navigateResolvedUrl(buildActualPreviewUrl(resolvedOrigin.value, parsed.path), parsed.path)
      })
      return
    }
    navigateResolvedUrl(nextActualUrl, parsed.path)
  }
}

function submitAddress(): void {
  applyTarget(addressInput.value)
}

function submitEmpty(): void {
  applyTarget(emptyInput.value)
}

function updateMobileHistoryPath(index: number): void {
  const path = mobileHistory.value[index]
  if (!path || !committedTarget.value) return
  mobileHistoryIndex.value = index
  const updated: WebPreviewTarget = { ...committedTarget.value, path }
  committedTarget.value = updated
  addressInput.value = formatLogicalPreviewUrl(updated)
  emit("change", updated)
  iframeKey.value++
}

function goBack(): void {
  if (isDesktopWebview.value) webviewEl?.goBack?.()
  else if (mobileHistoryIndex.value > 0) updateMobileHistoryPath(mobileHistoryIndex.value - 1)
}

function goForward(): void {
  if (isDesktopWebview.value) webviewEl?.goForward?.()
  else if (mobileHistoryIndex.value < mobileHistory.value.length - 1) updateMobileHistoryPath(mobileHistoryIndex.value + 1)
}

function reload(): void {
  if (addressDirty.value && addressInput.value.trim()) {
    submitAddress()
    return
  }
  loadError.value = null
  if (connectError.value) {
    retryNonce.value++
    return
  }
  if (!useDirectLocal.value && activeForwardId) {
    const currentForwardId = activeForwardId
    void isActiveForwardRetired().then(retired => {
      if (activeForwardId !== currentForwardId) return
      if (retired) {
        retryNonce.value++
        return
      }
      reloadCurrentTarget()
    })
    return
  }
  reloadCurrentTarget()
}

function openExternal(): void {
  const url = actualUrl.value
  if (!url) return
  if (client.openExternal) void client.openExternal(url)
  else window.open(url, "_blank", "noopener,noreferrer")
}

function openDevTools(): void {
  if (!client.webPreview || guestWebContentsId.value === null) return
  void client.webPreview.openDevTools(guestWebContentsId.value).catch(reason => {
    loadError.value = reason instanceof Error ? reason.message : String(reason)
  })
}
</script>

<template>
  <section class="flex h-full min-h-0 flex-col bg-ui-surface text-ui-text" :aria-label="t('webPreview.title')" data-web-preview>
    <header class="flex shrink-0 items-center gap-1 border-b border-ui-border px-2 py-1.5">
      <UiButton variant="ghost" size="icon" :label="t('webPreview.back')" :disabled="!canGoBack" data-web-preview-back @click="goBack">
        <ArrowLeft :size="15" :stroke-width="1.75" aria-hidden="true" />
      </UiButton>
      <UiButton variant="ghost" size="icon" :label="t('webPreview.forward')" :disabled="!canGoForward" data-web-preview-forward @click="goForward">
        <ArrowRight :size="15" :stroke-width="1.75" aria-hidden="true" />
      </UiButton>
      <UiButton variant="ghost" size="icon" :label="t('webPreview.reload')" :disabled="!canReload && !connectError" data-web-preview-reload @click="reload">
        <LoaderCircle v-if="connecting || pageLoading" :size="15" :stroke-width="1.75" class="animate-spin" aria-hidden="true" />
        <RotateCw v-else :size="15" :stroke-width="1.75" aria-hidden="true" />
      </UiButton>
      <form class="flex min-w-0 flex-1 items-center gap-1" @submit.prevent="submitAddress">
        <input
          ref="addressInputEl"
          v-model="addressInput"
          type="text"
          enterkeyhint="go"
          spellcheck="false"
          autocomplete="off"
          autocapitalize="off"
          :aria-label="t('webPreview.addressLabel')"
          :placeholder="t('webPreview.addressPlaceholder')"
          data-web-preview-address
          class="ui-input h-8 min-w-0 flex-1 px-2.5 text-xs"
          @input="addressError = null"
        />
        <UiButton
          v-if="addressDirty && addressInput.trim()"
          type="submit"
          size="sm"
          variant="primary"
          data-web-preview-go
          class="h-8 shrink-0 px-2.5 text-xs"
        >{{ t('webPreview.open') }}</UiButton>
      </form>
      <UiButton variant="ghost" size="icon" :label="t('webPreview.openExternal')" :disabled="!canOpenExternal" data-web-preview-external @click="openExternal">
        <ExternalLink :size="15" :stroke-width="1.75" aria-hidden="true" />
      </UiButton>
      <UiButton v-if="isDesktopWebview" variant="ghost" size="icon" :label="t('webPreview.openDevTools')" :disabled="!canOpenDevTools" data-web-preview-devtools @click="openDevTools">
        <CodeXml :size="15" :stroke-width="1.75" aria-hidden="true" />
      </UiButton>
    </header>

    <p v-if="addressError" role="alert" data-web-preview-address-error class="m-0 border-b border-ui-danger/25 bg-ui-danger/5 px-3 py-1.5 text-xs text-ui-danger">
      {{ addressError }}
    </p>

    <div v-if="!committedTarget" class="ui-empty flex-1 px-4" data-web-preview-empty>
      <Globe :size="28" class="mb-2 text-ui-text-muted" aria-hidden="true" />
      <p class="m-0 text-sm font-medium">{{ t('webPreview.emptyTitle') }}</p>
      <p class="m-0 mt-1 max-w-sm text-center text-[13px] leading-5 text-ui-text-muted">{{ t('webPreview.emptyDescription') }}</p>
      <form class="mt-4 flex w-full max-w-xs items-center gap-2" @submit.prevent="submitEmpty">
        <input
          v-model="emptyInput"
          type="text"
          enterkeyhint="go"
          spellcheck="false"
          autocomplete="off"
          autocapitalize="off"
          :aria-label="t('webPreview.addressLabel')"
          :placeholder="t('webPreview.portPlaceholder')"
          data-web-preview-empty-input
          class="ui-input h-8 min-w-0 flex-1 px-2.5 text-xs"
          @input="addressError = null"
        />
        <UiButton type="submit" size="sm" variant="primary" data-web-preview-open>{{ t('webPreview.open') }}</UiButton>
      </form>
      <div class="mt-3 flex flex-wrap items-center justify-center gap-1.5">
        <button
          v-for="port in QUICK_PORTS"
          :key="port"
          type="button"
          :data-web-preview-quick-port="port"
          class="cursor-pointer rounded-md border border-ui-border px-2 py-1 text-xs text-ui-text-muted ui-motion hover:bg-ui-hover hover:text-ui-text"
          @click="applyTarget(String(port))"
        >:{{ port }}</button>
      </div>
    </div>

    <div v-else-if="machineOffline" class="ui-empty flex-1 px-4" data-web-preview-offline>
      <Globe :size="28" class="mb-2 text-ui-text-muted" aria-hidden="true" />
      <p class="m-0 text-sm font-medium">{{ t('webPreview.offlineTitle') }}</p>
      <p class="m-0 mt-1 max-w-sm text-center text-[13px] leading-5 text-ui-text-muted">{{ t('webPreview.offlineDescription') }}</p>
    </div>

    <div v-else-if="connectError" class="flex flex-1 items-center justify-center p-4" data-web-preview-error>
      <div class="w-full max-w-md">
        <ErrorNotice :error="connectError" :title="t('webPreview.connectErrorTitle')" :description="connectError">
          <UiButton size="sm" data-web-preview-retry @click="retryNonce++">{{ t('webPreview.retry') }}</UiButton>
        </ErrorNotice>
      </div>
    </div>

    <div v-else-if="connecting && !resolvedOrigin" class="ui-empty flex-1 px-4" data-web-preview-connecting>
      <LoaderCircle :size="24" class="mb-2 animate-spin text-ui-text-muted" aria-hidden="true" />
      <p class="m-0 text-sm text-ui-text-muted">{{ t('webPreview.connecting') }}</p>
    </div>

    <div v-else class="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <div v-if="loadError" class="border-b border-ui-border p-3" data-web-preview-load-error>
        <ErrorNotice :error="loadError" :title="t('webPreview.loadFailedTitle')" :description="loadError">
          <UiButton size="sm" data-web-preview-retry @click="reload">{{ t('webPreview.retry') }}</UiButton>
        </ErrorNotice>
      </div>
      <div v-if="isDesktopWebview" ref="webviewHost" data-web-preview-webview-host class="flex min-h-0 flex-1 flex-col" />
      <iframe
        v-else-if="actualUrl"
        :key="`${iframeKey}:${actualUrl}`"
        :src="actualUrl"
        :title="formatWebPreviewTabTitle(committedTarget, pageTitle, t('webPreview.title'))"
        data-web-preview-iframe
        class="min-h-0 w-full flex-1 border-0 bg-white"
      />
    </div>
  </section>
</template>
