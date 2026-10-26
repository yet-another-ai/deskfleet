<script setup lang="ts">
import { useI18n } from "vue-i18n"
import { useRouteWorktree } from "../../composables/useRouteWorktree.ts"
import GitChanges from "./GitChanges.vue"

const { t } = useI18n()
const worktree = useRouteWorktree()
</script>

<template>
  <aside
    :aria-label="t('panel.changes')"
    class="flex w-72 shrink-0 flex-col border-l border-ui-border bg-ui-canvas"
  >
    <div class="titlebar-overlay-inset app-drag flex h-12 shrink-0 items-center pl-4">
      <h2 class="m-0 text-[13px] font-medium">{{ t('panel.changes') }}</h2>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-1">
      <GitChanges v-if="worktree" :key="worktree.session.id" :session-id="worktree.session.id" :enabled="worktree.machine.online" />
      <p v-else class="m-0 text-[13px] text-ui-text-muted">{{ t('panel.noWorktree') }}</p>
    </div>
  </aside>
</template>
