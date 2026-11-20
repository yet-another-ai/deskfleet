<script setup lang="ts">
import { Archive, Bot } from "@lucide/vue"
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import type { RouteLocationRaw } from "vue-router"
import { useSessionLabel } from "../../composables/useSessionLabel.ts"
import { sessionIsUnread } from "../../services/agent-conversation.ts"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"
import type { AgentSessionSummary } from "../../stores/fleet-types.ts"
import ProviderIcon from "../common/ProviderIcon.vue"
import UiButton from "../common/UiButton.vue"
import SessionContextMenu from "../session/SessionContextMenu.vue"
import SessionPresenceIcon from "./SessionPresenceIcon.vue"
import SessionPullRequestIndicators from "./SessionPullRequestIndicators.vue"
import SessionUnreadIndicator from "./SessionUnreadIndicator.vue"
import SessionWorkingIndicator from "./SessionWorkingIndicator.vue"
import TreeLink from "./TreeLink.vue"

const props = defineProps<{ machineId: string; session: AgentSessionSummary; online: boolean; projectWorker?: boolean; depth: 0 | 1; to: RouteLocationRaw }>()
const { t } = useI18n()
const sessionLabel = useSessionLabel()
const agents = useAgentSessionsStore()
const indicator = computed(() => props.session.archiveState === "archiving" ? "archiving" : agents.isWorking(props.session.id))
</script>

<template>
  <SessionContextMenu v-slot="{ requestArchive, pending }" :machine-id="machineId" :session-id="session.id" :title="session.title ?? ''" :context="session.context" :archive-state="session.archiveState" :project-worker="projectWorker" :disabled="!online">
    <!-- A Session's shells open in its bottom panel, not the sidebar. -->
    <TreeLink
      :machine-id="machineId"
      :to="to"
      :icon="Bot"
      :label="sessionLabel(session)"
      :depth="depth"
    >
      <template #icon>
        <SessionPresenceIcon :session-id="session.id" :machine-id="machineId">
          <span v-if="!session.provider && !session.providerUnavailable" class="h-3.5 w-3.5 shrink-0 rounded bg-ui-border" data-provider-pending aria-hidden="true" />
          <ProviderIcon v-else :icon="session.providerIcon" :template="session.providerTemplate" :size="15" />
        </SessionPresenceIcon>
      </template>
      <template #trailing>
        <SessionPullRequestIndicators :machine-id="machineId" :session-id="session.id" />
        <SessionWorkingIndicator v-if="indicator" :state="indicator" />
        <SessionUnreadIndicator v-else-if="sessionIsUnread(session)" />
      </template>
      <template v-if="session.archiveState === 'active' || session.archiveState === 'archiving'" #actions>
        <UiButton
          variant="ghost"
          size="icon"
          class="text-current [&:not(:disabled,[aria-disabled=true])]:hover:bg-current/15 [&:not(:disabled,[aria-disabled=true])]:hover:text-current [&:not(:disabled,[aria-disabled=true])]:active:bg-current/20"
          :label="t(session.archiveState === 'archiving' ? 'agent.retryArchive' : 'agent.archive')"
          :disabled="!online || pending || !session.context"
          @click="requestArchive()"
        >
          <Archive :size="16" :stroke-width="1.75" aria-hidden="true" />
        </UiButton>
      </template>
    </TreeLink>
  </SessionContextMenu>
</template>
