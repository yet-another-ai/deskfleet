<script lang="ts">
import { MessageSquare, MonitorPlay, SquareTerminal, X } from "@lucide/vue"
import { defineComponent } from "vue"
import UiTabTitle from "../common/UiTabTitle.vue"
import UiTooltip from "../common/UiTooltip.vue"

export default defineComponent({
  components: { MessageSquare, MonitorPlay, SquareTerminal, UiTabTitle, UiTooltip, X },
  props: {
    tabId: { type: String, required: true },
    title: { type: String, required: true },
    tooltip: { type: String, required: true },
    closeLabel: { type: String, required: true },
    closable: Boolean,
  },
  emits: { close: () => true },
})
</script>

<template>
  <UiTooltip :text="tooltip">
    <div
      class="ui-tab-size group flex h-full min-w-0 items-center gap-1.5 px-2.5 text-[13px]"
      :data-window-tab-id="tabId"
    >
      <MessageSquare v-if="tabId === 'chat'" :size="14" class="shrink-0" aria-hidden="true" />
      <MonitorPlay v-else-if="tabId === 'desktops'" :size="14" class="shrink-0" aria-hidden="true" />
      <SquareTerminal v-else-if="tabId.startsWith('terminal:')" :size="14" class="shrink-0" aria-hidden="true" />
      <span v-else class="shrink-0 text-xs font-semibold" aria-hidden="true">±</span>
      <UiTabTitle>{{ title }}</UiTabTitle>
      <button
        v-if="closable"
        type="button"
        class="ml-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-ui-text-muted op-0 pointer-events-none ui-motion hover:bg-ui-hover active:scale-90 hover:text-ui-text group-hover:op-100 group-hover:pointer-events-auto group-focus-within:op-100 group-focus-within:pointer-events-auto"
        :aria-label="closeLabel"
        @click.stop="$emit('close')"
      >
        <X :size="13" aria-hidden="true" />
      </button>
    </div>
  </UiTooltip>
</template>
