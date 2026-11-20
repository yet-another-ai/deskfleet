<script setup lang="ts">
import { ArrowDown } from "@lucide/vue"
import { useI18n } from "vue-i18n"
import UiButton from "../common/UiButton.vue"
withDefaults(defineProps<{ offset?: number }>(), { offset: 0 })
const emit = defineEmits<{ select: [] }>()
const { t } = useI18n()
</script>

<template>
  <div
    class="pointer-events-none absolute inset-x-0 z-20 flex justify-center"
    :style="{ bottom: `${offset + 8}px` }"
  >
    <div class="relative mx-auto flex w-full max-w-3xl justify-end px-6">
      <UiButton
        type="button"
        size="icon"
        class="pointer-events-auto h-8 w-8 rounded-full border border-ui-border bg-ui-surface text-ui-text shadow-ui-popover"
        :label="t('agent.scrollToBottom')"
        data-scroll-to-bottom
        @click="emit('select')"
      >
        <ArrowDown :size="16" :stroke-width="1.75" aria-hidden="true" />
      </UiButton>
    </div>
  </div>
</template>
