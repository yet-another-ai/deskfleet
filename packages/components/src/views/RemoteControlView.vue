<script setup lang="ts">
import { client as platformClient } from "@deskfleet/client/platform"
import { FolderSync, MonitorPlay, SquareTerminal } from "@lucide/vue"
import { computed, defineAsyncComponent, nextTick, ref, useId, watch } from "vue"
import { useI18n } from "vue-i18n"
import { useRoute, useRouter } from "vue-router"
import PaneHeader from "../components/chrome/PaneHeader.vue"
import ResourcePath from "../components/chrome/ResourcePath.vue"
import { useFileTarget } from "../composables/useFileTarget.ts"
import { useFleetStore } from "../stores/fleet.ts"
import { useTerminalsStore } from "../stores/terminals.ts"

const TerminalWorkspace = defineAsyncComponent(() => import("../components/terminal/TerminalWorkspace.vue"))
const FileTransferPanel = defineAsyncComponent(() => import("../components/files/FileTransferPanel.vue"))
const DesktopView = defineAsyncComponent(() => import("./DesktopView.vue"))

const props = defineProps<{ machineId: string }>()
const { t } = useI18n()
const route = useRoute(), router = useRouter()
const fleet = useFleetStore(), terminals = useTerminalsStore()
const machine = computed(() => fleet.findMachine(props.machineId))
const currentTarget = computed(() => props.machineId === fleet.targetId)
const files = platformClient.files
const target = useFileTarget(() => props.machineId)
const tabs = [
  { id: "terminal", label: "remoteControl.terminal", icon: SquareTerminal },
  { id: "desktop", label: "remoteControl.desktop", icon: MonitorPlay },
  { id: "files", label: "files.title", icon: FolderSync },
] as const
type Tool = typeof tabs[number]["id"]
const active = computed<Tool>(() => tabs.find(tab => tab.id === route.query.tab)?.id
  ?? (machine.value?.desktop ? "desktop" : "terminal"))
const visited = ref(new Set<Tool>())
watch(() => [machine.value?.id, active.value] as const, ([id, tool], previous) => {
  if (id !== previous?.[0]) visited.value = new Set()
  if (id) visited.value.add(tool)
}, { immediate: true })
const id = useId()
const tabId = (tool: Tool) => `${id}-${tool}-tab`
const panelId = (tool: Tool) => `${id}-${tool}-panel`

async function select(tool: Tool, focus = false): Promise<void> {
  await router.push({ name: "machine-control", params: { machineId: props.machineId }, query: { ...route.query, tab: tool } })
  if (focus) { await nextTick(); document.getElementById(tabId(tool))?.focus() }
}
function keydown(event: KeyboardEvent, index: number): void {
  let next: number
  if (event.key === "ArrowRight") next = (index + 1) % tabs.length
  else if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length
  else if (event.key === "Home") next = 0
  else if (event.key === "End") next = tabs.length - 1
  else return
  event.preventDefault()
  void select(tabs[next]!.id, true)
}

const machineTerminals = computed(() => currentTarget.value ? terminals.sessions.filter(terminal => terminal.worktreeId === undefined) : [])
const activeTerminal = computed({
  get: () => typeof route.query.terminal === "string" && machineTerminals.value.some(terminal => terminal.id === route.query.terminal)
    ? route.query.terminal : undefined,
  set: (terminal: string | undefined) => {
    const replace = !machineTerminals.value.some(item => item.id === route.query.terminal)
    const query = { ...route.query }
    if (terminal) query.terminal = terminal
    else delete query.terminal
    const to = { name: "machine-control", params: { machineId: props.machineId }, query }
    void (replace ? router.replace(to) : router.push(to))
  },
})
</script>

<template>
  <PaneHeader>
    {{ t('machine.remoteControl') }}
    <ResourcePath v-if="machine" :segments="[machine.name]" />
  </PaneHeader>
  <div v-if="machine" :key="machineId" class="flex min-h-0 flex-1 flex-col px-4 pb-4">
    <div role="tablist" :aria-label="t('machine.remoteControl')" class="mb-3 flex shrink-0 gap-1 overflow-x-auto border-b border-ui-border">
      <button
        v-for="(tab, index) in tabs" :id="tabId(tab.id)" :key="tab.id" type="button" role="tab"
        :aria-selected="active === tab.id" :aria-controls="panelId(tab.id)" :tabindex="active === tab.id ? 0 : -1"
        class="flex h-9 shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap border-b-2 px-3 text-[13px]"
        :class="active === tab.id ? 'border-ui-accent text-ui-accent' : 'border-transparent text-ui-text-muted hover:text-ui-text'"
        @click="select(tab.id)" @keydown="keydown($event, index)"
      ><component :is="tab.icon" :size="15" aria-hidden="true" />{{ t(tab.label) }}</button>
    </div>
    <!-- Visit tools on demand, then retain their connections and state while switching tabs. -->
    <div v-if="visited.has('terminal')" v-show="active === 'terminal'" :id="panelId('terminal')" role="tabpanel" :aria-labelledby="tabId('terminal')" class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-ui-border">
      <TerminalWorkspace v-if="currentTarget" v-model:active-id="activeTerminal" :terminals="machineTerminals" :create="() => terminals.create()" />
      <p v-else class="m-auto p-6 text-sm text-ui-text-muted">{{ t('terminal.unavailable') }}</p>
    </div>
    <div v-if="visited.has('desktop')" v-show="active === 'desktop'" :id="panelId('desktop')" role="tabpanel" :aria-labelledby="tabId('desktop')" class="flex min-h-0 flex-1 flex-col">
      <DesktopView :machine-id="machineId" />
    </div>
    <div v-if="visited.has('files')" v-show="active === 'files'" :id="panelId('files')" role="tabpanel" :aria-labelledby="tabId('files')" class="flex min-h-0 flex-1 flex-col overflow-auto">
      <FileTransferPanel v-if="files && target && currentTarget" :key="target.kind === 'machine' ? `${target.teamId}:${target.machineId}` : 'local'" :api="files" :target="target" :machine-name="machine.name" />
      <p v-else class="m-auto p-6 text-sm text-ui-text-muted">{{ t('remoteControl.filesUnavailable') }}</p>
    </div>
  </div>
  <p v-else class="m-auto p-6 text-sm text-ui-text-muted">{{ t('desktop.notFound') }}</p>
</template>
