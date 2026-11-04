<script setup lang="ts">
import { MonitorPlay, Pause, Play, RefreshCw } from "@lucide/vue"
import { useDocumentVisibility } from "@vueuse/core"
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import PaneHeader from "../components/chrome/PaneHeader.vue"
import UiButton from "../components/common/UiButton.vue"
import MachineDesktopPreviews from "../components/desktop/MachineDesktopPreviews.vue"
import { useAccountSession } from "../composables/useAccountSession.ts"

const { t } = useI18n()
const account = useAccountSession()
const visibility = useDocumentVisibility()
const paused = ref(false)
const showAll = ref(false)
const active = computed(() => !paused.value && visibility.value === "visible")
// The selected machine owns the current workspace and its sessions.
const machines = computed(() => account?.machines.value.filter(machine => machine.teamId === account.teamId.value
  && machine.id !== account.localMachineId.value && (showAll.value || machine.id === account.machineId.value)) ?? [])
const scope = computed(() => JSON.stringify([account?.account.value.serverUrl, account?.account.value.user?.id, account?.teamId.value]))
const revision = ref(0)
watch(scope, () => { showAll.value = false })

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
  <PaneHeader>{{ t('desktopOverview.title') }}</PaneHeader>
  <div class="min-h-0 flex-1 overflow-y-auto px-5 pb-10 pt-6 lg:px-8">
    <div class="mx-auto flex max-w-7xl flex-col gap-7">
      <header class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 class="ui-page-title">{{ t('desktopOverview.title') }}</h1>
          <p class="m-0 mt-1 max-w-xl text-sm text-ui-text-muted">{{ t('desktopOverview.description') }}</p>
        </div>
        <div class="flex gap-2">
          <UiButton type="button" :aria-pressed="paused" @click="paused = !paused">
            <component :is="paused ? Play : Pause" :size="14" aria-hidden="true" />{{ t(paused ? 'desktopOverview.resume' : 'desktopOverview.pause') }}
          </UiButton>
          <UiButton type="button" @click="refresh"><RefreshCw :size="14" aria-hidden="true" />{{ t('desktop.retry') }}</UiButton>
        </div>
      </header>
      <div class="flex gap-1.5" role="group" :aria-label="t('desktopOverview.scope')">
        <button v-for="all in [false, true]" :key="String(all)" type="button"
          class="cursor-pointer rounded-full px-3 py-1.5 text-[13px] ui-motion active:scale-[0.97]"
          :class="showAll === all ? 'bg-ui-active text-ui-text' : 'text-ui-text-muted hover:bg-ui-hover'"
          :aria-pressed="showAll === all" @click="showAll = all"
        >{{ t(all ? 'desktopOverview.allMachines' : 'desktopOverview.currentMachine') }}</button>
      </div>
      <p v-if="paused" role="status" class="ui-notice m-0">{{ t('desktopOverview.paused') }}</p>
      <div v-if="!machines.length" class="ui-empty">
        <MonitorPlay :size="28" class="mb-2 text-ui-text-muted" aria-hidden="true" />
        <p class="m-0 text-sm font-medium">{{ t(showAll ? 'desktopOverview.empty' : 'desktopOverview.currentEmpty') }}</p>
        <p class="m-0 max-w-md text-center text-[13px] leading-5 text-ui-text-muted">{{ t(showAll ? 'desktopOverview.emptyHint' : 'desktopOverview.currentEmptyHint') }}</p>
      </div>
      <div v-else class="flex flex-wrap items-start gap-6">
        <MachineDesktopPreviews
          v-for="machine in machines" :key="`${scope}:${machine.id}`"
          :machine="machine" :active="active" :revision="revision"
          @open="open(machine.id, $event)"
        />
      </div>
    </div>
  </div>
</template>
