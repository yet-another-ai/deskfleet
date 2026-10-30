<script setup lang="ts">
import { Pin } from "@lucide/vue"
import { useArrayFilter } from "@vueuse/core"
import { useId } from "vue"
import { useI18n } from "vue-i18n"
import { useRoute, useRouter } from "vue-router"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import { useSessionLabel } from "../../composables/useSessionLabel.ts"
import { sessionIsUnread, snapshotIsWorking } from "../../services/agent-conversation.ts"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"
import { useFleetStore } from "../../stores/fleet.ts"
import { usePinnedSessionsStore } from "../../stores/pinned-sessions.ts"
import SessionContextMenu from "../session/SessionContextMenu.vue"
import SessionWorkingIndicator from "./SessionWorkingIndicator.vue"
import SessionUnreadIndicator from "./SessionUnreadIndicator.vue"

const { t } = useI18n()
const id = useId()
const pins = usePinnedSessionsStore()
const agents = useAgentSessionsStore()
const fleet = useFleetStore()
const account = useAccountSession()
const route = useRoute()
const router = useRouter()
const sessionLabel = useSessionLabel()
const visiblePins = useArrayFilter(() => pins.items, item => item.archiveState !== "archived")

function active(machineId: string, sessionId: string): boolean {
  return route.name === "session" && route.params.sessionId === sessionId
    && (!account || account.machineId.value === machineId)
}
function open(machineId: string, sessionId: string): void {
  if (account) account.openSession(machineId, sessionId)
  else void router.push({ name: "session", params: { sessionId } })
}
/** Live turns are only projected for the selected machine's agent connection. */
function working(machineId: string, sessionId: string): boolean {
  return machineId === fleet.targetId && snapshotIsWorking(agents.views[sessionId]?.snapshot)
}
</script>

<template>
  <section v-if="visiblePins.length" :aria-labelledby="id" data-pinned-sessions class="mb-5">
    <h2 :id="id" class="m-0 mb-2 px-2.5 text-xs font-normal text-ui-text-faint">{{ t('pinnedSessions.title') }}</h2>
    <ul class="m-0 flex list-none flex-col gap-1 p-0">
      <li v-for="item in visiblePins" :key="`${item.machineId}:${item.sessionId}`" :data-pinned-machine="item.machineId" :data-pinned-session="item.sessionId">
        <SessionContextMenu :machine-id="item.machineId" :session-id="item.sessionId" :title="item.title" :archive-state="item.archiveState" :disabled="!item.online || !item.loaded">
          <button
            type="button"
            class="ui-nav-item w-full px-2.5 text-left"
            :class="active(item.machineId, item.sessionId) && 'ui-nav-active'"
            :aria-current="active(item.machineId, item.sessionId) ? 'page' : undefined"
            :title="`${sessionLabel({ id: item.sessionId, title: item.title })} · ${item.machineName}`"
            @click="open(item.machineId, item.sessionId)"
          >
            <Pin :size="15" :stroke-width="1.75" class="shrink-0" aria-hidden="true" />
            <span class="min-w-0 flex-1 truncate">{{ sessionLabel({ id: item.sessionId, title: item.title }) }}</span>
            <SessionWorkingIndicator v-if="working(item.machineId, item.sessionId)" />
            <SessionUnreadIndicator v-else-if="sessionIsUnread(item)" />
            <span v-if="!item.online" class="ui-badge shrink-0 rounded-full font-normal">{{ t('machine.offline') }}</span>
          </button>
        </SessionContextMenu>
      </li>
    </ul>
  </section>
</template>
