<script setup lang="ts">
import { client as platformClient } from "@deskfleet/client/platform"
import { Activity, FolderSync, MonitorPlay, SquareTerminal } from "@lucide/vue"
import { watchImmediate } from "@vueuse/core"
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from "reka-ui"
import { computed, defineAsyncComponent, ref } from "vue"
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
const SystemStatusPanel = defineAsyncComponent(() => import("../components/system/SystemStatusPanel.vue"))

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
  { id: "system", label: "systemStatus.title", icon: Activity },
] as const
type Tool = typeof tabs[number]["id"]
const active = computed<Tool>(() => tabs.find(tab => tab.id === route.query.tab)?.id
  ?? (machine.value?.desktop ? "desktop" : "terminal"))
const visited = ref(new Set<Tool>())
watchImmediate(() => [machine.value?.id, active.value] as const, ([id, tool], previous) => {
  if (id !== previous?.[0]) visited.value = new Set()
  if (id) visited.value.add(tool)
})
async function select(tool: Tool): Promise<void> {
  await router.push({ name: "machine-control", params: { machineId: props.machineId }, query: { ...route.query, tab: tool } })
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
  <TabsRoot v-if="machine" :key="machineId" :model-value="active" class="flex min-h-0 flex-1 flex-col px-4 pb-4" @update:model-value="select">
    <TabsList :aria-label="t('machine.remoteControl')" class="mb-3 flex shrink-0 gap-1 overflow-x-auto border-b border-ui-border" loop>
      <TabsTrigger
        v-for="tab in tabs" :key="tab.id" :value="tab.id"
        class="flex h-9 shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap border-b-2 px-3 text-[13px]"
        :class="active === tab.id ? 'border-ui-accent text-ui-accent' : 'border-transparent text-ui-text-muted hover:text-ui-text'"
      ><component :is="tab.icon" :size="15" aria-hidden="true" />{{ t(tab.label) }}</TabsTrigger>
    </TabsList>
    <!-- Retain visited tools and their state; desktop capture stops when its tab is hidden. -->
    <TabsContent v-if="visited.has('terminal')" v-show="active === 'terminal'" value="terminal" force-mount class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-ui-border">
      <TerminalWorkspace v-if="currentTarget" v-model:active-id="activeTerminal" :terminals="machineTerminals" :create="() => terminals.create()" />
      <p v-else class="m-auto p-6 text-sm text-ui-text-muted">{{ t('terminal.unavailable') }}</p>
    </TabsContent>
    <TabsContent v-if="visited.has('desktop')" v-show="active === 'desktop'" value="desktop" force-mount class="flex min-h-0 flex-1 flex-col">
      <DesktopView :machine-id="machineId" :visible="active === 'desktop'" />
    </TabsContent>
    <TabsContent v-if="visited.has('files')" v-show="active === 'files'" value="files" force-mount class="flex min-h-0 flex-1 flex-col overflow-auto">
      <FileTransferPanel v-if="files && target && currentTarget" :key="target.kind === 'machine' ? `${target.teamId}:${target.machineId}` : 'local'" :api="files" :target="target" :machine-name="machine.name" />
      <p v-else class="m-auto p-6 text-sm text-ui-text-muted">{{ t('remoteControl.filesUnavailable') }}</p>
    </TabsContent>
    <TabsContent v-if="visited.has('system')" v-show="active === 'system'" value="system" force-mount class="flex min-h-0 flex-1 flex-col overflow-auto">
      <SystemStatusPanel v-if="currentTarget" :machine-id="machineId" :machine-name="machine.name" :online="machine.online" :active="active === 'system'" />
      <p v-else class="m-auto p-6 text-sm text-ui-text-muted">{{ t('systemStatus.unavailable') }}</p>
    </TabsContent>
  </TabsRoot>
  <p v-else class="m-auto p-6 text-sm text-ui-text-muted">{{ t('desktop.notFound') }}</p>
</template>
