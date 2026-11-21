<script setup lang="ts">
import type { PortForward } from "@deskfleet/client/ports"
import {
  ExternalLink,
  Globe,
  LoaderCircle,
  RotateCw,
} from "@lucide/vue"
import { watchImmediate } from "@vueuse/core"
import { computed, ref } from "vue"
import { useI18n } from "vue-i18n"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import {
  formatWebPreviewTabTitle,
  formatWebPreviewUrl,
  parseWebPreviewInput,
  type WebPreviewTarget,
} from "../../services/web-preview.ts"
import ErrorNotice from "../common/ErrorNotice.vue"
import UiButton from "../common/UiButton.vue"

const QUICK_PORTS = [3000, 5173, 8080] as const

const props = defineProps<{
  sessionId: string
  initialUrl?: string | null
}>()
const emit = defineEmits<{
  change: [url: string]
}>()

const { t } = useI18n()
const client = usePlatformClient()
const fleet = useFleetStore()

const committedTarget = ref<WebPreviewTarget | null>(props.initialUrl ? parseWebPreviewInput(props.initialUrl) : null)
const addressInput = ref(committedTarget.value ? formatWebPreviewUrl(committedTarget.value) : "")
const addressError = ref<string | null>(null)
const connectError = ref<string | null>(null)
const connecting = ref(false)
const forward = ref<PortForward | null>(null)
const retryNonce = ref(0)
const iframeKey = ref(0)

const account = useAccountSession()
const machine = computed(() => fleet.findSession(props.sessionId)?.machine)
const useDirectLocal = computed(() => Boolean(machine.value?.local && client.platform !== "web"))
const teamId = computed(() => account?.machines.value.find(item => item.id === machine.value?.id)?.teamId ?? fleet.catalog?.teamId)
const machineOffline = computed(() => Boolean(committedTarget.value && machine.value && !machine.value.local && !machine.value.online))

const actualUrl = computed(() => {
  const target = committedTarget.value
  if (!target || !machine.value || machineOffline.value) return undefined
  if (useDirectLocal.value) return formatWebPreviewUrl(target, true)
  return forward.value ? `http://127.0.0.1:${forward.value.localPort}${target.path}` : undefined
})
const title = computed(() => formatWebPreviewTabTitle(committedTarget.value, t("webPreview.title")))
const committedLogicalUrl = computed(() => (committedTarget.value ? formatWebPreviewUrl(committedTarget.value) : ""))
const addressDirty = computed(() => addressInput.value.trim() !== committedLogicalUrl.value)

watchImmediate(
  [
    () => machine.value?.id,
    () => Boolean(machine.value?.local || machine.value?.online),
    useDirectLocal,
    teamId,
    () => committedTarget.value?.host,
    () => committedTarget.value?.port,
    retryNonce,
  ],
  ([machineId, reachable, direct, resolvedTeamId, host, port], _previous, onCleanup) => {
    let cancelled = false
    let startedId: string | undefined

    forward.value = null
    connectError.value = null

    onCleanup(() => {
      cancelled = true
      if (startedId) void client.ports?.stop(startedId).catch(() => {})
    })

    if (direct || !machineId || !reachable || !resolvedTeamId || !host || !port) {
      connecting.value = false
      return
    }
    if (!client.ports) {
      connectError.value = t("webPreview.unavailable")
      connecting.value = false
      return
    }

    connecting.value = true
    void client.ports
      .start({ target: { teamId: resolvedTeamId, machineId }, targetHost: host, targetPort: port })
      .then(result => {
        if (cancelled) {
          void client.ports?.stop(result.id).catch(() => {})
          return
        }
        startedId = result.id
        forward.value = result
      })
      .catch(reason => {
        if (!cancelled) connectError.value = reason instanceof Error ? reason.message : String(reason)
      })
      .finally(() => {
        if (!cancelled) connecting.value = false
      })
  },
)

async function ensureForwardAlive(): Promise<boolean> {
  const current = forward.value
  if (!current || !client.ports) return true
  try {
    const active = await client.ports.list()
    if (forward.value?.id !== current.id) return false
    if (!active.some(entry => entry.id === current.id)) {
      retryNonce.value++
      return false
    }
  } catch {
    // Ignore transient list errors and keep the current forward.
  }
  return true
}

async function applyTarget(raw: string): Promise<void> {
  const parsed = parseWebPreviewInput(raw)
  if (!parsed) {
    addressError.value = t("webPreview.invalidAddress")
    return
  }
  const previous = committedTarget.value
  const sameOrigin = previous?.host === parsed.host && previous?.port === parsed.port
  const samePath = previous?.path === parsed.path
  const logicalUrl = formatWebPreviewUrl(parsed)
  committedTarget.value = parsed
  addressInput.value = logicalUrl
  addressError.value = null
  emit("change", logicalUrl)

  if (sameOrigin && await ensureForwardAlive() && samePath) iframeKey.value++
}

async function reload(): Promise<void> {
  if (addressDirty.value && addressInput.value.trim()) {
    await applyTarget(addressInput.value)
    return
  }
  if (connectError.value) {
    retryNonce.value++
    return
  }
  if (await ensureForwardAlive()) iframeKey.value++
}

function openExternal(): void {
  const url = actualUrl.value
  if (url) window.open(url, "_blank", "noopener,noreferrer")
}
</script>

<template>
  <section class="flex h-full min-h-0 flex-col bg-ui-surface text-ui-text" :aria-label="t('webPreview.title')" data-web-preview>
    <header class="flex shrink-0 items-center gap-1 border-b border-ui-border px-2 py-1.5">
      <UiButton variant="ghost" size="icon" :label="t('webPreview.reload')" :disabled="!actualUrl && !connectError" data-web-preview-reload @click="reload">
        <LoaderCircle v-if="connecting" :size="15" :stroke-width="1.75" class="animate-spin" aria-hidden="true" />
        <RotateCw v-else :size="15" :stroke-width="1.75" aria-hidden="true" />
      </UiButton>
      <form class="flex min-w-0 flex-1 items-center gap-1" @submit.prevent="applyTarget(addressInput)">
        <input
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
      <UiButton variant="ghost" size="icon" :label="t('webPreview.openExternal')" :disabled="!actualUrl" data-web-preview-external @click="openExternal">
        <ExternalLink :size="15" :stroke-width="1.75" aria-hidden="true" />
      </UiButton>
    </header>

    <p v-if="addressError" role="alert" data-web-preview-address-error class="m-0 border-b border-ui-danger/25 bg-ui-danger/5 px-3 py-1.5 text-xs text-ui-danger">
      {{ addressError }}
    </p>

    <div v-if="!committedTarget" class="ui-empty flex-1 px-4" data-web-preview-empty>
      <Globe :size="28" class="mb-2 text-ui-text-muted" aria-hidden="true" />
      <p class="m-0 text-sm font-medium">{{ t('webPreview.emptyTitle') }}</p>
      <p class="m-0 mt-1 max-w-sm text-center text-[13px] leading-5 text-ui-text-muted">{{ t('webPreview.emptyDescription') }}</p>
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

    <div v-else-if="connecting && !actualUrl" class="ui-empty flex-1 px-4" data-web-preview-connecting>
      <LoaderCircle :size="24" class="mb-2 animate-spin text-ui-text-muted" aria-hidden="true" />
      <p class="m-0 text-sm text-ui-text-muted">{{ t('webPreview.connecting') }}</p>
    </div>

    <iframe
      v-else-if="actualUrl"
      :key="`${iframeKey}:${actualUrl}`"
      :src="actualUrl"
      :title="title"
      sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-downloads"
      data-web-preview-iframe
      class="min-h-0 h-full w-full flex-1 border-0 bg-white"
    />
  </section>
</template>
