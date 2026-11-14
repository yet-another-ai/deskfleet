<script setup lang="ts">
import { vNavigationMotion } from "../directives/navigation-motion.ts"
import { useNavigationMotion } from "../composables/useNavigationMotion.ts"
import { MonitorPlay, Pause, Play, RefreshCw } from "@lucide/vue"
import { useDocumentVisibility } from "@vueuse/core"
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import PaneHeader from "../components/chrome/PaneHeader.vue"
import UiButton from "../components/common/UiButton.vue"
import UiScrollArea from "../components/common/UiScrollArea.vue"
import MachineDesktopPreviews from "../components/desktop/MachineDesktopPreviews.vue"
import { useAccountSession } from "../composables/useAccountSession.ts"

const { t } = useI18n()
const motion = useNavigationMotion()
const account = useAccountSession()
const visibility = useDocumentVisibility()
const paused = ref(false)
const revision = ref(0)
const active = computed(() => !paused.value && visibility.value === "visible")
const machines = computed(() => account?.machines.value.filter(machine => machine.teamId === account.teamId.value
  && machine.id !== account.localMachineId.value) ?? [])
const scope = computed(() => JSON.stringify([account?.account.value.serverUrl, account?.account.value.user?.id, account?.teamId.value]))
watch(scope, () => { paused.value = false }, { flush: "sync" })

function refresh(): void {
  revision.value++
  void account?.refreshMachines()
}

function open(machineId: string, displayId: number): void {
  account?.openMachineRoute(machineId, {
    name: "machine-control", params: { machineId },
    query: { tab: "desktop", display: String(displayId), connect: "1" },
  })
}
</script>

<template>
  <PaneHeader>
    {{ t('nav.remoteDesktop') }}
    <template #actions>
      <div class="app-no-drag flex gap-0.5">
        <UiButton variant="ghost" size="icon" :label="t(paused ? 'desktopOverview.resume' : 'desktopOverview.pause')" :aria-pressed="paused" @click="paused = !paused"><component :is="paused ? Play : Pause" :size="16" :stroke-width="1.75" aria-hidden="true" /></UiButton>
        <UiButton variant="ghost" size="icon" :label="t('desktop.retry')" @click="refresh"><RefreshCw :size="16" :stroke-width="1.75" aria-hidden="true" /></UiButton>
      </div>
    </template>
  </PaneHeader>
  <UiScrollArea class="min-h-0 flex-1" content-class="p-4" :aria-label="t('nav.remoteDesktop')" data-remote-desktops>
    <div v-navigation-motion="motion">
      <p v-if="paused" role="status" class="ui-notice m-0 mb-4">{{ t('desktopOverview.paused') }}</p>
      <div v-if="!machines.length" class="ui-empty">
        <MonitorPlay :size="28" class="mb-2 text-ui-text-muted" aria-hidden="true" />
        <p class="m-0 text-sm font-medium">{{ t('desktopOverview.empty') }}</p>
        <p class="m-0 max-w-md text-center text-[13px] leading-5 text-ui-text-muted">{{ t('desktopOverview.emptyHint') }}</p>
      </div>
      <div v-else class="grid grid-cols-[repeat(auto-fill,minmax(min(100%,320px),1fr))] items-start gap-4">
        <MachineDesktopPreviews
          v-for="machine in machines" :key="`${scope}:${machine.id}`"
          :machine="machine" :active="active" :revision="revision" tiled
          @open="open(machine.id, $event)"
        />
      </div>
    </div>
  </UiScrollArea>
</template>
