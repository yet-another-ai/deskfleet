<script setup lang="ts">
import { ChevronsDownUp, Pencil } from "@lucide/vue"
import { useI18n } from "vue-i18n"

withDefaults(defineProps<{
  sourceMessageId: string
  touch?: boolean
  reEditDisabled?: boolean
  showFold?: boolean
}>(), {
  showFold: true,
})
const emit = defineEmits<{ reEdit: []; fold: [] }>()
const { t } = useI18n()
</script>

<template>
  <div
    :data-stopped-turn-actions="sourceMessageId"
    class="my-1 inline-flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs"
  >
    <button
      type="button"
      :data-reedit-stopped-turn="sourceMessageId"
      :disabled="reEditDisabled"
      :class="touch && 'min-h-11 px-1.5'"
      class="inline-flex cursor-pointer items-center gap-1 rounded py-0.5 font-medium text-ui-accent hover:underline disabled:cursor-default disabled:opacity-50"
      @click="emit('reEdit')"
    >
      <Pencil :size="12" aria-hidden="true" />
      <span>{{ t("superAgent.reEdit.action") }}</span>
    </button>
    <button
      v-if="showFold"
      type="button"
      :data-fold-stopped-turn="sourceMessageId"
      :class="touch && 'min-h-11 px-1.5'"
      class="inline-flex cursor-pointer items-center gap-1 rounded py-0.5 text-ui-text-muted hover:text-ui-text hover:underline"
      @click="emit('fold')"
    >
      <ChevronsDownUp :size="12" aria-hidden="true" />
      <span>{{ t("superAgent.reEdit.fold") }}</span>
    </button>
  </div>
</template>
