<script setup lang="ts">
import { MonitorPlay, Pause, Play, RefreshCw } from "@lucide/vue"
import { useDocumentVisibility } from "@vueuse/core"
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import UiButton from "../common/UiButton.vue"
import UiScrollArea from "../common/UiScrollArea.vue"
import MachineDesktopPreviews from "./MachineDesktopPreviews.vue"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import { useFleetStore } from "../../stores/fleet.ts"

const props = withDefaults(defineProps<{ sessionId: string; active?: boolean }>(), { active: true })
const { t } = useI18n()
const account = useAccountSession()
const fleet = useFleetStore()
const visibility = useDocumentVisibility()
const paused = ref(false)
const showAll = ref(false)
const active = computed(() => props.active && !paused.value && visibility.value === "visible")
const sessionMachineId = computed(() => fleet.findSession(props.sessionId)?.machine.id)
// Resolve ownership from this Session, independently of account navigation or new-session drafts.
const machines = computed(() => account?.machines.value.filter(machine => machine.teamId === account.teamId.value
  && machine.id !== account.localMachineId.value && (showAll.value || machine.id === sessionMachineId.value)) ?? [])
const scope = computed(() => JSON.stringify([account?.account.value.serverUrl, account?.account.value.user?.id, account?.teamId.value, props.sessionId, sessionMachineId.value]))
const revision = ref(0)
watch(scope, () => { showAll.value = false; paused.value = false }, { flush: "sync" })

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
  <section class="flex h-full min-h-0 flex-col" :aria-label="t('desktopOverview.title')" data-session-desktops>
    <header class="flex flex-wrap items-center justify-between gap-1 border-b border-ui-border px-3 py-2">
      <div class="flex gap-1" role="group" :aria-label="t('desktopOverview.scope')">
        <button v-for="all in [false, true]" :key="String(all)" type="button"
          class="cursor-pointer rounded-md px-2 py-1.5 text-xs ui-motion active:scale-[0.97]"
          :class="showAll === all ? 'bg-ui-active text-ui-text' : 'text-ui-text-muted hover:bg-ui-hover'"
          :aria-pressed="showAll === all" @click="showAll = all"
        >{{ t(all ? 'desktopOverview.allMachines' : 'desktopOverview.sessionMachine') }}</button>
      </div>
      <div class="flex gap-0.5">
        <UiButton variant="ghost" size="icon" :label="t(paused ? 'desktopOverview.resume' : 'desktopOverview.pause')" :aria-pressed="paused" @click="paused = !paused"><component :is="paused ? Play : Pause" :size="16" :stroke-width="1.75" aria-hidden="true" /></UiButton>
        <UiButton variant="ghost" size="icon" :label="t('desktop.retry')" @click="refresh"><RefreshCw :size="16" :stroke-width="1.75" aria-hidden="true" /></UiButton>
      </div>
    </header>
    <UiScrollArea class="min-h-0 flex-1" content-class="flex flex-col gap-4 p-3">
      <p v-if="paused" role="status" class="ui-notice m-0">{{ t('desktopOverview.paused') }}</p>
      <div v-if="!machines.length" class="ui-empty">
        <MonitorPlay :size="28" class="mb-2 text-ui-text-muted" aria-hidden="true" />
        <p class="m-0 text-sm font-medium">{{ t(showAll ? 'desktopOverview.empty' : 'desktopOverview.sessionEmpty') }}</p>
        <p class="m-0 max-w-md text-center text-[13px] leading-5 text-ui-text-muted">{{ t(showAll ? 'desktopOverview.emptyHint' : 'desktopOverview.sessionEmptyHint') }}</p>
      </div>
      <div v-else class="flex flex-col items-start gap-5">
        <MachineDesktopPreviews
          v-for="machine in machines" :key="`${scope}:${machine.id}`"
          :machine="machine" :active="active" :revision="revision"
          @open="open(machine.id, $event)"
        />
      </div>
    </UiScrollArea>
  </section>
</template>
