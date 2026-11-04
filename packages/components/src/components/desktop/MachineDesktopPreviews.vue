<script setup lang="ts">
import { LoaderCircle, Monitor } from "@lucide/vue"
import { watchImmediate } from "@vueuse/core"
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { Machine } from "@deskfleet/client/central"
import type { DesktopCapabilities } from "@deskfleet/client/desktop-media"
import { remoteMachineClient } from "@deskfleet/client/remote"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import UiButton from "../common/UiButton.vue"
import DesktopPreviewCard from "./DesktopPreviewCard.vue"

const props = defineProps<{ machine: Machine; active: boolean; revision: number }>()
defineEmits<{ open: [displayId: number] }>()
const { t } = useI18n()
const account = useAccountSession()!
// Preview adapters belong to the Session panel; they never open machine catalogs.
const remote = remoteMachineClient(usePlatformClient(), account.central, props.machine)
const capabilities = shallowRef<DesktopCapabilities | null>(null)
const width = computed(() => `${Math.max(1, capabilities.value?.displays.length ?? 0) * 336 - 16}px`)
const loading = ref(false)
const error = shallowRef<unknown>(null)
let generation = 0

watch(() => props.machine, machine => remote.updateMachine(machine), { deep: true })

async function discover(): Promise<void> {
  const run = ++generation
  capabilities.value = null
  error.value = null
  loading.value = false
  if (!props.active || !props.machine.online || props.machine.capabilities.desktop !== true) return
  loading.value = true
  try {
    const available = await remote.api.desktop.capabilities()
    if (run === generation) capabilities.value = available
  } catch (reason) {
    if (run === generation) error.value = reason
  } finally {
    if (run === generation) loading.value = false
  }
}

watchImmediate(() => [props.machine.online, props.machine.capabilities.desktop, props.revision] as const, () => { void discover() })
watch(() => props.active, active => {
  if (!active) { ++generation; loading.value = false }
  else if (!capabilities.value && !error.value) void discover()
})
onBeforeUnmount(() => { ++generation; remote.dispose() })
</script>

<template>
  <section class="flex min-w-0 max-w-full flex-col gap-3" :style="{ width }" :aria-label="machine.name" :data-preview-machine="machine.id">
    <header class="flex min-w-0 items-center gap-2.5">
      <Monitor :size="17" :stroke-width="1.75" class="shrink-0 text-ui-text-muted" aria-hidden="true" />
      <h2 class="m-0 truncate text-sm font-semibold">{{ machine.name }}</h2>
      <span class="ui-status-dot shrink-0" :class="machine.online ? 'text-ui-success' : 'text-ui-text-faint'" aria-hidden="true" />
      <span v-if="!machine.online" class="text-xs text-ui-text-muted">{{ t('desktopOverview.offline') }}</span>
      <span v-else-if="capabilities?.displays.length" class="shrink-0 whitespace-nowrap text-xs text-ui-text-faint">{{ t('desktopOverview.displayCount', { count: capabilities.displays.length }) }}</span>
    </header>
    <div v-if="capabilities?.displays.length" class="grid grid-cols-[repeat(auto-fill,minmax(min(100%,320px),1fr))] gap-4">
      <DesktopPreviewCard v-for="display in capabilities.displays" :key="`${revision}:${display.id}`" :api="remote.api.desktop" :display="display" :machine-name="machine.name" :active="active && machine.online" @open="$emit('open', display.id)" />
    </div>
    <div v-else class="flex min-h-28 items-center gap-3 rounded-xl border border-ui-border bg-ui-surface px-5 py-4 text-sm text-ui-text-muted">
      <LoaderCircle v-if="loading" :size="18" class="shrink-0 animate-spin" aria-hidden="true" />
      <p v-if="error" role="alert" class="m-0 min-w-0 flex-1 break-words">{{ error instanceof Error ? error.message : String(error) }}</p>
      <p v-else role="status" class="m-0 flex-1">{{ t(!machine.online ? 'desktopOverview.offlineHint' : machine.capabilities.desktop !== true ? 'desktopOverview.unavailable' : loading ? 'desktop.checking' : !active ? 'desktopOverview.paused' : 'desktopOverview.noDisplays') }}</p>
      <UiButton v-if="error" type="button" :disabled="!active" @click="discover">{{ t('desktop.retry') }}</UiButton>
    </div>
  </section>
</template>
