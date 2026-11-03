<script setup lang="ts">
import { X } from "@lucide/vue"
import { storeToRefs } from "pinia"
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { useRouteWorktree } from "../../composables/useRouteWorktree.ts"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"
import { useLayoutStore } from "../../stores/layout.ts"
import GitChanges from "./GitChanges.vue"
import IconButton from "../common/IconButton.vue"

defineProps<{ windowed?: boolean; standalone?: boolean }>()
const { t } = useI18n()
const worktree = useRouteWorktree()
const agents = useAgentSessionsStore()
const layout = useLayoutStore()
const { compact } = storeToRefs(layout)

const unavailable = computed(() => {
  const session = worktree.value && agents.sessions[worktree.value.session.id]
  const archiveState = session?.archiveState ?? worktree.value?.session.archiveState
  if (archiveState && archiveState !== "active") return t(archiveState === "archived" ? "agent.archived" : "agent.archiving")
  if (session && session.lifecycle !== "ready") return t(`agent.lifecycle.${session.lifecycle}`)
  return null
})
</script>

<template>
  <aside
    :aria-label="t('panel.changes')"
    class="relative flex h-full w-full shrink-0 flex-col bg-ui-canvas"
    :class="!windowed && 'border-l border-ui-border'"
  >
    <div v-if="!windowed" class="titlebar-overlay-inset app-drag flex h-12 shrink-0 items-center pl-4">
      <h2 class="m-0 flex-1 text-[13px] font-medium">{{ t('panel.changes') }}</h2>
      <IconButton v-if="compact" :icon="X" :label="t('toolbar.hidePanel')" @click="layout.toggleDetails()" />
    </div>
    <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <GitChanges v-if="worktree && !unavailable" :key="worktree.session.id" class="min-h-0 min-w-0 flex-1" :session-id="worktree.session.id" :enabled="worktree.machine.online" />
      <p v-else class="m-0 px-4 pt-1 text-[13px] text-ui-text-muted">{{ unavailable ?? t('panel.noWorktree') }}</p>
    </div>
  </aside>
</template>
