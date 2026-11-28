<script setup lang="ts">
import { ChevronRight, Pin, Unplug } from "@lucide/vue"
import { useArrayFilter } from "@vueuse/core"
import { computed, ref, useId } from "vue"
import { useI18n } from "vue-i18n"
import { useRoute, useRouter } from "vue-router"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import { useSessionLabel } from "../../composables/useSessionLabel.ts"
import { useSidebarFilter } from "../../composables/useSidebarFilter.ts"
import { pinnedSessionOrderGroup, useSidebarOrder } from "../../composables/useSidebarOrder.ts"
import { useWorkspaceAgentSummary } from "../../composables/useWorkspaceAgentSummary.ts"
import { sessionIsUnread } from "../../services/agent-conversation.ts"
import { usePinnedSessionsStore } from "../../stores/pinned-sessions.ts"
import SessionContextMenu from "../session/SessionContextMenu.vue"
import SessionHoverTooltip from "./SessionHoverTooltip.vue"
import SessionWorkingIndicator from "./SessionWorkingIndicator.vue"
import SessionUnreadIndicator from "./SessionUnreadIndicator.vue"
import SessionPullRequestIndicators from "./SessionPullRequestIndicators.vue"
import SidebarReorderRow from "./SidebarReorderRow.vue"

const props = defineProps<{ collapsible?: boolean }>()
const { t } = useI18n()
const id = useId()
const pins = usePinnedSessionsStore()
const saSummary = useWorkspaceAgentSummary()
const expanded = ref(false)
const account = useAccountSession()
const route = useRoute()
const router = useRouter()
const sessionLabel = useSessionLabel()
const visiblePins = useArrayFilter(() => pins.items, item => item.archiveState !== "archived")
const sidebarFilter = useSidebarFilter()
const sidebarOrder = useSidebarOrder()
const filteredPins = computed(() => {
  const mode = sidebarFilter.filter.value
  if (mode === "all") return visiblePins.value
  return visiblePins.value.filter(item => {
    const busy = item.archiveState === "archiving" || Boolean(item.working)
    return mode === "working" ? busy : !busy && sessionIsUnread(item)
  })
})
const orderedPins = computed(() => sidebarOrder.ordered(pinnedSessionOrderGroup, filteredPins.value.map(item => ({
  ...item, id: JSON.stringify([item.machineId, item.sessionId]),
}))))
const pinLabel = (item: { sessionId: string; title: string }) => sessionLabel({ id: item.sessionId, title: item.title })
function pinWorking(item: (typeof orderedPins.value)[number]) {
  if (props.collapsible && !item.online) return false
  return item.archiveState === "archiving" ? "archiving" : item.working
}
function pinUnread(item: (typeof orderedPins.value)[number]) {
  if (!sessionIsUnread(item)) return false
  if (!props.collapsible) return true
  return !saSummary.isDelegatedWorkerSuperseded(item.machineId, item.sessionId, item.lastCompletedSeq)
}

function active(machineId: string, sessionId: string): boolean {
  return route.name === "session" && route.params.sessionId === sessionId
    && (!account || account.machineId.value === machineId)
}
function open(machineId: string, sessionId: string): void {
  if (account) account.openSession(machineId, sessionId)
  else void router.push({ name: "session", params: { sessionId } })
}
</script>

<template>
  <section v-if="orderedPins.length" :aria-labelledby="id" data-pinned-sessions class="mb-5">
    <h2 :id="id" class="m-0 mb-2 px-2.5 text-xs font-normal text-ui-text-faint">
      <button v-if="collapsible" type="button" :aria-expanded="expanded" class="inline-flex items-center gap-1" @click="expanded = !expanded">
        <ChevronRight :size="13" :class="expanded && 'rotate-90'" aria-hidden="true" />{{ t('pinnedSessions.title') }}
      </button>
      <template v-else>{{ t('pinnedSessions.title') }}</template>
    </h2>
    <ul v-if="!collapsible || expanded" class="m-0 flex list-none flex-col gap-1 p-0">
      <SidebarReorderRow v-for="item in orderedPins" :key="item.id" v-slot="{ source }" as="li" :group="pinnedSessionOrderGroup" :id="item.id" :items="orderedPins" :data-pinned-machine="item.machineId" :data-pinned-session="item.sessionId">
        <SessionContextMenu :machine-id="item.machineId" :session-id="item.sessionId" :title="item.title" :context="item.context" :archive-state="item.archiveState" :disabled="!item.online || !item.loaded">
          <SessionHoverTooltip :machine-id="item.machineId" :session-id="item.sessionId" :title="pinLabel(item)" :machine-name="item.machineName" :online="item.online" :context="item.context">
            <button
              v-bind="source"
              type="button"
              class="ui-nav-item w-full px-2.5 text-left"
              :class="active(item.machineId, item.sessionId) && 'ui-nav-active'"
              :aria-current="active(item.machineId, item.sessionId) ? 'page' : undefined"
              @click="open(item.machineId, item.sessionId)"
            >
              <Pin :size="15" :stroke-width="1.75" class="shrink-0" aria-hidden="true" />
              <span class="min-w-0 flex-1 truncate">{{ pinLabel(item) }}</span>
              <SessionPullRequestIndicators :machine-id="item.machineId" :session-id="item.sessionId" />
              <SessionWorkingIndicator v-if="pinWorking(item)" :state="pinWorking(item)" />
              <SessionUnreadIndicator v-else-if="pinUnread(item)" />
              <span v-if="!item.online" class="inline-flex shrink-0 items-center text-ui-warning" :title="t('machine.offline')">
                <Unplug :size="14" :stroke-width="1.75" aria-hidden="true" />
                <span class="sr-only">{{ t('machine.offline') }}</span>
              </span>
            </button>
          </SessionHoverTooltip>
        </SessionContextMenu>
      </SidebarReorderRow>
    </ul>
  </section>
</template>
