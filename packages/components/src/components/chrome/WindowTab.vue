<script lang="ts">
import { MessageSquare, SquareTerminal, X } from "@lucide/vue"
import { defineComponent } from "vue"
import UiTooltip from "../common/UiTooltip.vue"

export default defineComponent({
  components: { MessageSquare, SquareTerminal, UiTooltip, X },
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
      class="group flex h-full min-w-0 items-center gap-1.5 px-2.5 text-[13px] font-medium"
      :data-window-tab-id="tabId"
    >
      <MessageSquare v-if="tabId === 'chat'" :size="14" aria-hidden="true" />
      <SquareTerminal v-else-if="tabId.startsWith('terminal:')" :size="14" aria-hidden="true" />
      <span v-else class="text-xs font-semibold" aria-hidden="true">±</span>
      <span class="truncate">{{ title }}</span>
      <button
        v-if="closable"
        type="button"
        class="ml-1 inline-flex h-5 w-5 items-center justify-center rounded text-ui-text-muted op-0 pointer-events-none transition-opacity duration-120 ease-out hover:bg-ui-hover hover:text-ui-text group-hover:op-100 group-hover:pointer-events-auto group-focus-within:op-100 group-focus-within:pointer-events-auto"
        :aria-label="closeLabel"
        @click.stop="$emit('close')"
      >
        <X :size="13" aria-hidden="true" />
      </button>
    </div>
  </UiTooltip>
</template>
