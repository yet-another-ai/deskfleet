<script setup lang="ts">
import {
  Archive,
  Bot,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  MonitorPlay,
  SquarePen,
  SquareTerminal,
} from "@lucide/vue"
import { computed, ref } from "vue"
import { CollapsibleContent, CollapsibleRoot, CollapsibleTrigger } from "reka-ui"
import { useI18n } from "vue-i18n"
import { RouterLink, useRouter, type RouteLocationRaw } from "vue-router"
import { intlLocale, type AppLocale } from "../../../../client/src/i18n.ts"
import type { MachineSummary } from "../../stores/fleet-types.ts"
import { useSessionLabel } from "../../composables/useSessionLabel.ts"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import IconButton from "../common/IconButton.vue"
import ProviderIcon from "../common/ProviderIcon.vue"
import WorkspaceCreateDialog from "../catalog/WorkspaceCreateDialog.vue"
import SessionContextMenu from "../session/SessionContextMenu.vue"
import { snapshotIsWorking } from "../../services/agent-conversation.ts"
import SessionWorkingIndicator from "./SessionWorkingIndicator.vue"
import TreeLink from "./TreeLink.vue"

const props = defineProps<{ machine: MachineSummary }>()
const { t, locale } = useI18n()
const sessionLabel = useSessionLabel()
const agents = useAgentSessionsStore()
const fleet = useFleetStore()
const router = useRouter()
const account = useAccountSession()
const selected = computed(() => !account || account.machineId.value === props.machine.id)
const addingWorkspace = ref(false)
const archiving = ref(new Set<string>())
const archiveErrors = ref<Record<string, string>>({})

async function archiveSession(sessionId: string): Promise<void> {
  if (archiving.value.has(sessionId)) return
  archiving.value.add(sessionId)
  delete archiveErrors.value[sessionId]
  try {
    await agents.archive(sessionId)
  } catch (reason) {
    archiveErrors.value[sessionId] = reason instanceof Error ? reason.message : String(reason)
  } finally {
    archiving.value.delete(sessionId)
  }
}

function openRoute(destination: RouteLocationRaw): void {
  if (account) account.openMachineRoute(props.machine.id, destination)
  else void router.push(destination)
}

function workspaceCreated(id: string): void {
  addingWorkspace.value = false
  openRoute({ name: "workspace", params: { workspaceId: id } })
}

function startSession(workspaceId: string): void {
  fleet.targetWorkspace(workspaceId)
  openRoute({ name: "new-session" })
}

function openWorkspace(workspaceId: string, event: MouseEvent, navigate: (event?: MouseEvent) => unknown): void {
  if (!account) { void navigate(event); return }
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return
  if ((event.currentTarget as HTMLAnchorElement).target === "_blank") return
  event.preventDefault()
  openRoute({ name: "workspace", params: { workspaceId } })
}

const collapsed = computed(() => fleet.isCollapsed(props.machine.id))
const lastSeen = computed(() => {
  if (!props.machine.lastSeen) return undefined
  const time = new Intl.DateTimeFormat(intlLocale(locale.value as AppLocale), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(props.machine.lastSeen))
  return t("machine.lastSeen", { time })
})
const terminalLink = (terminalId: string) => ({ name: "terminal", params: { terminalId } })
const sessionWorking = (sessionId: string) => snapshotIsWorking(agents.views[sessionId]?.snapshot)
</script>

<template>
  <CollapsibleRoot as="section" :data-machine-id="machine.id" :open="!collapsed" class="mt-4 first:mt-0" @update:open="fleet.toggleMachine(machine.id)">
    <div class="group flex h-8 items-center gap-1 pl-2.5 pr-1">
      <CollapsibleTrigger
        type="button"
        class="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left text-[13px] font-medium text-ui-text-muted hover:text-ui-text"
      >
        <span class="truncate">{{ machine.name }}</span>
        <span v-if="machine.local" class="ui-badge shrink-0 rounded-full font-normal">{{ t("machine.local") }}</span>
        <span
          v-if="!machine.online"
          class="ui-badge shrink-0 rounded-full font-normal"
          :title="lastSeen"
        >
          {{ t("machine.offline") }}
        </span>
        <ChevronRight v-if="collapsed" :size="14" class="shrink-0" aria-hidden="true" />
      </CollapsibleTrigger>
      <div v-if="machine.online" class="flex op-0 group-hover:op-100 group-focus-within:op-100">
        <IconButton :icon="FolderPlus" :label="t('machine.addWorkspace')" :placeholder="false" :disabled="!fleet.canManageCatalog" @click="addingWorkspace = true" />
      </div>
    </div>
    <WorkspaceCreateDialog v-if="addingWorkspace" @created="workspaceCreated" @cancel="addingWorkspace = false" />

    <CollapsibleContent as="ul" class="mt-1 flex flex-col gap-1">
      <li>
        <TreeLink
          :machine-id="machine.id"
          :to="{ name: 'machine-control', params: { machineId: machine.id } }"
          :icon="machine.local ? SquareTerminal : MonitorPlay"
          :label="t(machine.local ? 'machine.localControl' : 'machine.remoteControl')"
          :depth="0"
        />
      </li>
      <li v-for="session in machine.sessions" :key="session.id">
        <SessionContextMenu :machine-id="machine.id" :session-id="session.id" :title="session.title ?? ''" :archive-state="session.archiveState" :disabled="!machine.online || archiving.has(session.id)">
          <TreeLink
            :machine-id="machine.id"
            :to="{ name: 'session', params: { sessionId: session.id } }"
            :icon="Bot"
            :label="sessionLabel(session)"
            :depth="0"
          >
            <template #icon>
              <span v-if="!session.provider && !session.providerUnavailable" class="h-3.5 w-3.5 shrink-0 rounded bg-ui-border" data-provider-pending aria-hidden="true" />
              <ProviderIcon v-else :icon="session.providerIcon" :template="session.providerTemplate" :size="15" />
            </template>
            <template v-if="sessionWorking(session.id)" #trailing>
              <SessionWorkingIndicator />
            </template>
            <template v-if="session.archiveState === 'active' || session.archiveState === 'archiving'" #actions>
              <IconButton
                :icon="Archive"
                :label="t(session.archiveState === 'archiving' ? 'agent.retryArchive' : 'agent.archive')"
                :disabled="!machine.online || archiving.has(session.id)"
                @click="archiveSession(session.id)"
              />
            </template>
          </TreeLink>
        </SessionContextMenu>
        <p v-if="archiveErrors[session.id]" role="alert" class="m-0 px-2.5 pb-1 pl-6 text-xs text-ui-danger break-words">{{ archiveErrors[session.id] }}</p>
      </li>
      <li v-if="machine.workspaces.length === 0 && machine.sessions.length === 0" class="h-8 px-2.5 leading-8 text-ui-text-faint">
        {{ t("machine.noWorkspaces") }}
      </li>
      <CollapsibleRoot v-for="workspace in machine.workspaces" :key="workspace.id" v-slot="{ open }" as="li" default-open class="flex flex-col gap-1">
        <RouterLink v-slot="{ href, navigate, isActive, isExactActive }" :to="{ name: 'workspace', params: { workspaceId: workspace.id } }" custom>
          <div class="workspace-row ui-nav-item relative" :class="selected && isActive && 'ui-nav-active'">
            <a :href="href" :aria-current="selected && isExactActive ? 'page' : undefined" class="flex h-full min-w-0 flex-1 items-center gap-2.5 pl-2.5 pr-9" @click="openWorkspace(workspace.id, $event, navigate)">
              <component :is="open ? FolderOpen : Folder" :size="15" :stroke-width="1.75" class="workspace-folder-icon shrink-0" aria-hidden="true" />
              <span class="truncate">{{ workspace.name }}</span>
            </a>
            <CollapsibleTrigger type="button" :aria-label="workspace.name" class="workspace-collapse-trigger absolute left-1.5 top-1 flex h-6 w-6 cursor-pointer items-center justify-center rounded-md">
              <ChevronRight :size="15" :stroke-width="1.75" class="workspace-collapse-icon shrink-0" :class="open && 'rotate-90'" aria-hidden="true" />
            </CollapsibleTrigger>
            <div class="workspace-session-action absolute inset-y-0 right-1 flex items-center">
              <IconButton :icon="SquarePen" :label="t('workspace.newSession')" class="text-inherit enabled:hover:bg-transparent enabled:hover:text-inherit" :disabled="!machine.online" @click="startSession(workspace.id)" />
            </div>
          </div>
        </RouterLink>
        <CollapsibleContent as="ul" class="flex flex-col gap-1 empty:hidden">
          <li v-for="terminal in workspace.terminals" :key="terminal.id">
            <TreeLink :machine-id="machine.id" :to="terminalLink(terminal.id)" :icon="SquareTerminal" :label="terminal.title" :depth="1" />
          </li>
          <li v-for="session in workspace.sessions" :key="session.id">
            <SessionContextMenu :machine-id="machine.id" :session-id="session.id" :title="session.title ?? ''" :archive-state="session.archiveState" :disabled="!machine.online || archiving.has(session.id)">
              <!-- A Session's shells open in its bottom panel, not the sidebar. -->
              <TreeLink
                :machine-id="machine.id"
                :to="{ name: 'session', params: { sessionId: session.id } }"
                :icon="Bot"
                :label="sessionLabel(session)"
                :depth="1"
              >
                <template #icon>
                  <span v-if="!session.provider && !session.providerUnavailable" class="h-3.5 w-3.5 shrink-0 rounded bg-ui-border" data-provider-pending aria-hidden="true" />
                  <ProviderIcon v-else :icon="session.providerIcon" :template="session.providerTemplate" :size="15" />
                </template>
                <template v-if="sessionWorking(session.id)" #trailing>
                  <SessionWorkingIndicator />
                </template>
                <template v-if="session.archiveState === 'active' || session.archiveState === 'archiving'" #actions>
                  <IconButton
                    :icon="Archive"
                    :label="t(session.archiveState === 'archiving' ? 'agent.retryArchive' : 'agent.archive')"
                    :disabled="!machine.online || archiving.has(session.id)"
                    @click="archiveSession(session.id)"
                  />
                </template>
              </TreeLink>
            </SessionContextMenu>
            <p v-if="archiveErrors[session.id]" role="alert" class="m-0 px-2.5 pb-1 pl-6 text-xs text-ui-danger break-words">{{ archiveErrors[session.id] }}</p>
          </li>
        </CollapsibleContent>
      </CollapsibleRoot>
    </CollapsibleContent>
  </CollapsibleRoot>
</template>

<style scoped>
.workspace-folder-icon,
.workspace-collapse-trigger,
.workspace-collapse-icon,
.workspace-session-action {
  transition: opacity 100ms ease-out, transform 100ms ease-out;
}

.workspace-collapse-trigger,
.workspace-session-action {
  opacity: 0;
}

.workspace-row:is(:hover, :has(:focus-visible)) .workspace-folder-icon {
  opacity: 0;
}

.workspace-row:is(:hover, :has(:focus-visible)) :is(.workspace-collapse-trigger, .workspace-session-action) {
  opacity: 1;
}

@media (prefers-reduced-motion: reduce) {
  .workspace-folder-icon,
  .workspace-collapse-trigger,
  .workspace-collapse-icon,
  .workspace-session-action {
    transition: none;
  }
}
</style>
