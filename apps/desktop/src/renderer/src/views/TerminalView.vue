<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { useRouter } from "vue-router"
import PaneHeader from "../components/chrome/PaneHeader.vue"
import ResourcePath from "../components/chrome/ResourcePath.vue"
import TerminalSurface from "../components/terminal/TerminalSurface.vue"
import TerminalWorkspace from "../components/terminal/TerminalWorkspace.vue"
import { useFleetStore } from "../stores/fleet.ts"
import { useLayoutStore } from "../stores/layout.ts"
import { useTerminalsStore } from "../stores/terminals.ts"
import { useWorktreeLabel } from "../composables/useWorktreeLabel.ts"
import { useSessionLabel } from "../composables/useSessionLabel.ts"

const props = defineProps<{ terminalId?: string; machineId?: string }>()
const { t } = useI18n()
const worktreeLabel = useWorktreeLabel()
const sessionLabel = useSessionLabel()
const fleet = useFleetStore()
const terminals = useTerminalsStore()
const layout = useLayoutStore()
const router = useRouter()
const location = computed(() => props.terminalId ? fleet.findTerminal(props.terminalId) : null)
// Session terminals live in their Session's bottom panel.
watch(location, (value) => {
  if (!value?.session || !value.worktree) return
  terminals.selected[value.worktree.id] = value.terminal.id
  layout.terminalPanelOpen = true
  void router.replace({ name: "session", params: { sessionId: value.session.id } })
}, { immediate: true })
const machineTerminals = computed(() => terminals.sessions.filter(terminal => terminal.worktreeId === undefined))
// A click adds history; following a hung-up tab to its neighbour replaces it.
const activeTerminal = computed({
  get: () => props.terminalId,
  set: (id) => {
    const replace = !machineTerminals.value.some(terminal => terminal.id === props.terminalId)
    const to = id ? { name: "terminal", params: { terminalId: id } } : { name: "machine-terminals", params: { machineId: "local-daemon" } }
    void (replace ? router.replace(to) : router.push(to))
  },
})
// Retain the workspace while a hung-up terminal leaves the catalog and the route advances.
const lastLocalTerminalId = ref<string>()
watch(location, (value) => {
  if (value?.machine.id === "local-daemon") lastLocalTerminalId.value = value.terminal.id
}, { immediate: true })
const localWorkspace = computed(() => props.machineId === "local-daemon"
  || location.value?.machine.id === "local-daemon"
  || (props.terminalId !== undefined && props.terminalId === lastLocalTerminalId.value))
const scope = computed(() => localWorkspace.value
  ? [fleet.localDesktopTarget.name]
  : [location.value?.machine.name, location.value?.workspace?.name,
      location.value?.session ? sessionLabel(location.value.session) : undefined,
      location.value?.worktree ? worktreeLabel(location.value.session) : undefined]
    .filter((name): name is string => name !== undefined),
)
const banner = computed(() => `\x1b[2m${t("terminal.unavailable")}\x1b[0m\n`)
</script>

<template>
  <PaneHeader>
    <template v-if="localWorkspace || location">
      {{ localWorkspace ? t("terminal.tabs") : location?.terminal.title }}
      <ResourcePath :segments="scope" />
    </template>
  </PaneHeader>

  <div v-if="localWorkspace" class="flex min-h-0 flex-1 flex-col px-4 pb-4">
    <TerminalWorkspace v-model:active-id="activeTerminal" :terminals="machineTerminals" :create="() => terminals.create()" />
  </div>
  <div
    v-else-if="!location"
    class="flex min-h-0 flex-1 items-center justify-center px-6 text-ui-text-muted"
  >{{ t("terminal.notFound") }}</div>
  <div v-else class="flex min-h-0 flex-1 flex-col px-4 pb-4">
    <div class="min-h-0 flex-1 overflow-hidden rounded-xl bg-ui-terminal p-3">
      <TerminalSurface :key="terminalId" :banner="banner" />
    </div>
  </div>
</template>
