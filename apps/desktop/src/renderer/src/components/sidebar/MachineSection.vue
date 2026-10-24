<script setup lang="ts">
import {
  Bot,
  ChevronRight,
  Folder,
  FolderPlus,
  MonitorPlay,
  SquareTerminal,
} from "@lucide/vue"
import { computed, ref } from "vue"
import { useI18n } from "vue-i18n"
import { RouterLink, useRouter } from "vue-router"
import { intlLocale, type AppLocale } from "../../../../shared/i18n.ts"
import type { MachineSummary } from "../../stores/fleet-types.ts"
import { useSessionLabel } from "../../composables/useSessionLabel.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import { useTerminalsStore } from "../../stores/terminals.ts"
import IconButton from "../common/IconButton.vue"
import WorkspaceCreateDialog from "../catalog/WorkspaceCreateDialog.vue"
import TreeLink from "./TreeLink.vue"

const props = defineProps<{ machine: MachineSummary }>()
const { t, locale } = useI18n()
const sessionLabel = useSessionLabel()
const fleet = useFleetStore()
const terminals = useTerminalsStore()
const router = useRouter()
const creating = ref(false)
const createError = ref<string | null>(null)
const addingWorkspace = ref(false)

async function workspaceCreated(id: string): Promise<void> {
  addingWorkspace.value = false
  await router.push({ name: "workspace", params: { workspaceId: id } })
}

async function createTerminal(): Promise<void> {
  if (props.machine.id !== "local-daemon" || creating.value) return
  creating.value = true
  createError.value = null
  try {
    const terminal = await terminals.create()
    await router.push({ name: "terminal", params: { terminalId: terminal.id } })
  } catch (error) {
    createError.value = error instanceof Error ? error.message : String(error)
  } finally { creating.value = false }
}

const collapsed = computed(() => fleet.isCollapsed(props.machine.id))
const listId = computed(() => `machine-${props.machine.id}-resources`)
const lastSeen = computed(() => {
  if (!props.machine.lastSeen) return undefined
  const time = new Intl.DateTimeFormat(intlLocale(locale.value as AppLocale), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(props.machine.lastSeen))
  return t("machine.lastSeen", { time })
})
const terminalLink = (terminalId: string) => ({ name: "terminal", params: { terminalId } })
</script>

<template>
  <section class="mt-4 first:mt-0">
    <div class="group flex h-8 items-center gap-1 pl-2.5 pr-1">
      <button
        type="button"
        class="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left text-[13px] text-ui-text-faint hover:text-ui-text-muted"
        :aria-expanded="!collapsed"
        :aria-controls="listId"
        @click="fleet.toggleMachine(machine.id)"
      >
        <span class="truncate">{{ machine.name }}</span>
        <span
          v-if="!machine.online"
          class="ui-badge shrink-0 rounded-full border border-ui-border"
          :title="lastSeen"
        >
          {{ t("machine.offline") }}
        </span>
        <ChevronRight v-if="collapsed" :size="14" class="shrink-0" aria-hidden="true" />
      </button>
      <div v-if="machine.online" class="flex op-0 group-hover:op-100 group-focus-within:op-100">
        <IconButton
          :icon="SquareTerminal"
          :label="t('terminal.new')"
          :placeholder="machine.id !== 'local-daemon'"
          :disabled="creating"
          @click="createTerminal"
        />
        <IconButton :icon="FolderPlus" :label="t('machine.addWorkspace')" :placeholder="!machine.local" :disabled="!fleet.canManageCatalog" @click="addingWorkspace = true" />
      </div>
    </div>
    <p v-if="createError" role="alert" class="px-2.5 text-xs text-red-500">{{ createError }}</p>
    <WorkspaceCreateDialog v-if="addingWorkspace && machine.local" @created="workspaceCreated" @cancel="addingWorkspace = false" />

    <ul v-if="!collapsed" :id="listId">
      <li v-if="machine.desktop || machine.id === 'local-daemon'">
        <TreeLink
          :to="{ name: 'machine-desktop', params: { machineId: machine.id } }"
          :icon="MonitorPlay"
          :label="t('machine.remoteDesktop')"
          :depth="0"
        />
      </li>
      <li v-for="terminal in machine.terminals" :key="terminal.id">
        <TreeLink :to="terminalLink(terminal.id)" :icon="SquareTerminal" :label="terminal.title" :depth="0" />
      </li>
      <li v-if="machine.workspaces.length === 0" class="h-8 px-2.5 leading-8 text-ui-text-faint">
        {{ t("machine.noWorkspaces") }}
      </li>
      <li v-for="workspace in machine.workspaces" :key="workspace.id">
        <div class="group flex h-8 items-center gap-2.5 pl-2.5 pr-1 text-ui-text-muted">
          <Folder :size="16" :stroke-width="1.75" class="shrink-0" aria-hidden="true" />
          <RouterLink :to="{ name: 'workspace', params: { workspaceId: workspace.id } }" class="min-w-0 flex-1 truncate hover:text-ui-text">{{ workspace.name }}</RouterLink>
        </div>
        <ul>
          <li v-for="terminal in workspace.terminals" :key="terminal.id">
            <TreeLink :to="terminalLink(terminal.id)" :icon="SquareTerminal" :label="terminal.title" :depth="1" />
          </li>
          <li v-for="session in workspace.sessions" :key="session.id">
            <!-- A Session's shells open in its bottom panel, not the sidebar. -->
            <TreeLink
              :to="{ name: 'session', params: { sessionId: session.id } }"
              :icon="Bot"
              :label="sessionLabel(session)"
              :depth="1"
            />
          </li>
        </ul>
      </li>
    </ul>
  </section>
</template>
