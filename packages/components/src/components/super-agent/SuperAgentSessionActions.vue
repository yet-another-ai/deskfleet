<script setup lang="ts">
import type { SuperAgentSession } from "@deskfleet/client/super-agent"
import { Archive, ArchiveRestore, History, Trash2 } from "@lucide/vue"
import { useArrayFilter } from "@vueuse/core"
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuTrigger } from "reka-ui"
import { computed, shallowRef } from "vue"
import { useI18n } from "vue-i18n"
import { superAgentSessionKey } from "../../composables/useSuperAgentSessionsList.ts"
import ConfirmDialog from "../common/ConfirmDialog.vue"
import SpringSurface from "../common/SpringSurface.ts"
import UiButton from "../common/UiButton.vue"

const props = defineProps<{
  sessions: SuperAgentSession[]
  includeActive: boolean
  selected?: SuperAgentSession
  disabled: boolean
  sending: boolean
  change: (session: SuperAgentSession, action: "archive" | "restore" | "delete") => Promise<void>
}>()
const emit = defineEmits<{ select: [session: SuperAgentSession] }>()
const { t } = useI18n()
const archived = useArrayFilter(() => props.sessions, session => session.archived)
const active = useArrayFilter(() => props.sessions, session => !session.archived)
const groups = computed(() => [
  ...(props.includeActive && active.value.length ? [{ label: t("superAgent.history"), items: active.value }] : []),
  ...(archived.value.length ? [{ label: t("archivedSessions.title"), items: archived.value }] : []),
])
const action = shallowRef<"archive" | "restore" | "delete">()
const actionAvailable = computed(() => props.selected && (action.value === "archive" ? !props.selected.archived : props.selected.archived))
const title = computed(() => props.selected?.title || t("superAgent.untitled"))
async function confirm(): Promise<void> {
  if (actionAvailable.value && props.selected && action.value) await props.change(props.selected, action.value)
}
</script>

<template>
  <DropdownMenuRoot v-if="groups.length" :modal="false">
    <DropdownMenuTrigger :as="UiButton" variant="ghost" size="icon" :label="t(includeActive ? 'superAgent.history' : 'archivedSessions.title')" :disabled="sending">
      <History :size="16" aria-hidden="true" />
    </DropdownMenuTrigger>
    <DropdownMenuPortal>
      <DropdownMenuContent :as="SpringSurface" align="end" :side-offset="4" :collision-padding="8" loop class="ui-menu z-50 flex max-h-[var(--reka-dropdown-menu-content-available-height)] w-60 flex-col overflow-y-auto">
        <template v-for="group in groups" :key="group.label">
          <DropdownMenuLabel class="px-2 py-1 text-xs text-ui-text-muted">{{ group.label }}</DropdownMenuLabel>
          <DropdownMenuItem v-for="item in group.items" :key="superAgentSessionKey(item)" as="button" type="button" class="ui-menu-item" @select="emit('select', item)">
            <span class="truncate">{{ item.title || t('superAgent.untitled') }}</span>
          </DropdownMenuItem>
        </template>
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
  <template v-if="selected?.archived">
    <UiButton variant="ghost" size="icon" :label="t('agent.restore')" :disabled="disabled" @click="action = 'restore'"><ArchiveRestore :size="16" aria-hidden="true" /></UiButton>
    <UiButton variant="ghost" size="icon" :label="t('agent.delete')" :disabled="disabled" @click="action = 'delete'"><Trash2 :size="16" aria-hidden="true" /></UiButton>
  </template>
  <UiButton v-else-if="selected" variant="ghost" size="icon" :label="t('agent.archive')" :disabled="disabled || sending" @click="action = 'archive'"><Archive :size="16" aria-hidden="true" /></UiButton>

  <ConfirmDialog v-if="action && selected"
    :title="t('agent.' + action)"
    :description="t('superAgent.' + action + 'Question', { title })"
    :confirm-label="t('agent.' + action)"
    :tone="action === 'delete' ? 'danger' : 'primary'"
    :confirm-disabled="disabled || sending || !actionAvailable"
    :confirm="confirm"
    @close="action = undefined"
  />
</template>
