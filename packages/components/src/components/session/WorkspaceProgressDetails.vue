<script setup lang="ts">
import { ChevronRight } from "@lucide/vue"
import { computed, ref } from "vue"
import { useI18n } from "vue-i18n"
import type { SuperTicket } from "@deskfleet/protocol/super-agent"
import type { WorkspaceRequestFeedback } from "../../services/workspace-feedback.ts"

const props = defineProps<{
  feedback: WorkspaceRequestFeedback
  active: boolean
  tickets?: Map<string, SuperTicket>
  touch?: boolean
  onLoad?: (sourceMessageId: string, append?: boolean) => void
}>()

const { t } = useI18n()
const open = ref(false)
const panelId = computed(() => `workspace-process-${props.feedback.sourceMessageId}`)
const toggleLabel = computed(() => {
  if (props.active) return t(open.value ? "superAgent.feedback.hideProgress" : "superAgent.feedback.viewProgress")
  return t(open.value ? "superAgent.feedback.hideProcess" : "superAgent.feedback.viewProcess")
})

function toggle() {
  open.value = !open.value
  if (open.value && props.onLoad) {
    props.onLoad(props.feedback.sourceMessageId, false)
  }
}

function loadMore() {
  props.onLoad?.(props.feedback.sourceMessageId, true)
}

function ticketName(ticketId?: string): string | undefined {
  return ticketId ? props.tickets?.get(ticketId)?.title : undefined
}
</script>

<template>
  <div v-if="feedback.hasProcess" :data-progress-details-for="feedback.sourceMessageId" class="mt-1 text-xs text-ui-text-muted">
    <button
      type="button"
      data-toggle-progress-details
      :aria-expanded="open"
      :aria-controls="panelId"
      :class="touch && 'min-h-11 px-1'"
      class="inline-flex cursor-pointer items-center gap-1 rounded py-0.5 text-xs text-ui-text-muted hover:text-ui-text"
      @click.stop="toggle"
    >
      <ChevronRight :size="13" class="shrink-0 ui-motion" :class="open && 'rotate-90'" aria-hidden="true" />
      <span>{{ toggleLabel }}</span>
    </button>
    <div
      v-if="open"
      :id="panelId"
      data-progress-details-panel
      role="region"
      :aria-label="toggleLabel"
      class="mt-1.5 flex flex-col gap-1.5 rounded-lg border border-ui-border bg-ui-surface/40 px-2.5 py-2 text-xs"
    >
      <p v-if="feedback.loadingProcess && !feedback.activities.length" class="m-0 text-ui-text-muted">
        {{ t("superAgent.feedback.loadingProcess") }}
      </p>
      <p v-else-if="feedback.processError" role="alert" class="m-0 text-ui-danger">
        {{ feedback.processError }}
      </p>
      <ul v-if="feedback.activities.length" class="m-0 flex list-none flex-col gap-1 p-0">
        <li
          v-for="item in feedback.activities"
          :key="item.itemId"
          :data-activity-item="item.itemId"
          :data-activity-kind="item.activityKind ?? 'phase'"
          class="flex items-start gap-1.5 break-words leading-relaxed"
        >
          <span
            class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
            :class="item.activityStatus === 'failed' ? 'bg-ui-danger' : item.status === 'streaming' ? 'bg-ui-accent' : 'bg-ui-text-faint'"
            aria-hidden="true"
          />
          <span class="min-w-0 flex-1 whitespace-pre-wrap">
            <strong v-if="ticketName(item.ticketId)" class="mr-1 font-medium text-ui-text">{{ ticketName(item.ticketId) }} ·</strong>{{ item.text }}
          </span>
        </li>
      </ul>
      <button
        v-if="feedback.hasMoreProcess"
        type="button"
        data-load-more-process
        :disabled="feedback.loadingProcess"
        :class="touch && 'min-h-11'"
        class="w-fit cursor-pointer text-xs text-ui-accent hover:underline disabled:opacity-50"
        @click.stop="loadMore"
      >
        {{ t("superAgent.feedback.loadMoreProcess") }}
      </button>
    </div>
  </div>
</template>
