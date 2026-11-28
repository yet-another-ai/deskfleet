<script setup lang="ts">
import { TooltipContent, TooltipPortal, TooltipProvider, TooltipRoot, TooltipTrigger } from "reka-ui"
import { ref, useId } from "vue"
import { useI18n } from "vue-i18n"
import SpringSurface from "../common/SpringSurface.ts"

defineProps<{
  sourceMessageId: string
  hasStashedDraft?: boolean
  disabled?: boolean
  touch?: boolean
}>()
const emit = defineEmits<{ cancel: [] }>()
const { t } = useI18n()
const hintId = useId()
const hintOpen = ref(false)
let pointerPress = false

function onTouchPointerDown(): void {
  pointerPress = true
}
function onTouchFocus(): void {
  if (pointerPress) return
  hintOpen.value = true
}
function onTouchClick(): void {
  pointerPress = false
  hintOpen.value = !hintOpen.value
}
function onTouchBlur(): void {
  pointerPress = false
  hintOpen.value = false
}
</script>

<template>
  <div
    data-composer-reedit-banner
    :data-reedit-source="sourceMessageId"
    class="flex flex-col border-b border-ui-border/60 px-4 pt-2 pb-1.5 text-xs leading-4 text-ui-text-muted"
  >
    <div class="flex items-center justify-between gap-3">
      <div class="flex min-w-0 flex-1 items-center">
        <button
          v-if="touch"
          type="button"
          tabindex="0"
          data-reedit-status-hint
          :aria-expanded="hintOpen"
          :aria-describedby="hintOpen ? undefined : hintId"
          class="-my-2 inline-flex min-h-11 min-w-0 max-w-full cursor-pointer items-center truncate rounded-sm text-left text-ui-text-muted ui-motion hover:text-ui-text focus-visible:text-ui-text focus-visible:outline-2 focus-visible:outline-ui-focus focus-visible:outline-offset-2"
          @pointerdown="onTouchPointerDown"
          @click="onTouchClick"
          @focus="onTouchFocus"
          @blur="onTouchBlur"
          @keydown.escape="hintOpen = false"
        >
          <span class="truncate">{{ t("superAgent.reEdit.bannerTitle") }}</span><span v-if="hasStashedDraft" data-reedit-stashed-badge class="shrink-0 text-ui-text-faint"> · {{ t("superAgent.reEdit.bannerStashed") }}</span>
        </button>
        <TooltipProvider v-else :delay-duration="200">
          <TooltipRoot v-model:open="hintOpen">
            <TooltipTrigger as-child>
              <span
                tabindex="0"
                data-reedit-status-hint
                :aria-describedby="hintOpen ? undefined : hintId"
                class="min-w-0 max-w-full cursor-default truncate rounded-sm text-ui-text-muted ui-motion hover:text-ui-text focus-visible:text-ui-text focus-visible:outline-2 focus-visible:outline-ui-focus focus-visible:outline-offset-2"
                @focus="hintOpen = true"
                @blur="hintOpen = false"
                @keydown.escape="hintOpen = false"
              >
                <span>{{ t("superAgent.reEdit.bannerTitle") }}</span><span v-if="hasStashedDraft" data-reedit-stashed-badge class="text-ui-text-faint"> · {{ t("superAgent.reEdit.bannerStashed") }}</span>
              </span>
            </TooltipTrigger>
            <TooltipPortal>
              <TooltipContent
                :as="SpringSurface"
                side="top"
                align="start"
                :side-offset="6"
                :collision-padding="8"
                data-reedit-hint-tooltip
                class="ui-tooltip z-70 max-w-[min(18rem,calc(100vw-2rem))] rounded-md border border-ui-border bg-ui-surface px-2.5 py-1.5 text-xs leading-5 text-ui-text shadow-ui-popover"
              >
                {{ t("superAgent.reEdit.bannerHint") }}
              </TooltipContent>
            </TooltipPortal>
          </TooltipRoot>
        </TooltipProvider>
        <span :id="hintId" class="sr-only">{{ t("superAgent.reEdit.bannerHint") }}</span>
      </div>
      <button
        type="button"
        data-cancel-reedit
        :disabled="disabled"
        :aria-label="t('superAgent.reEdit.exitLabel')"
        :class="touch && '-my-2 min-h-11 px-1.5'"
        class="shrink-0 cursor-pointer whitespace-nowrap rounded-sm px-0.5 text-xs font-normal text-ui-text-muted ui-motion hover:text-ui-text focus-visible:text-ui-text focus-visible:outline-2 focus-visible:outline-ui-focus focus-visible:outline-offset-2 disabled:cursor-default disabled:opacity-50"
        @click="emit('cancel')"
      >
        {{ t("superAgent.reEdit.exit") }}
      </button>
    </div>
    <div
      v-if="touch && hintOpen"
      data-reedit-hint-tooltip
      class="mt-1 rounded-md border border-ui-border/70 bg-ui-surface px-2.5 py-1.5 text-xs leading-5 text-ui-text"
    >
      <span role="tooltip">{{ t("superAgent.reEdit.bannerHint") }}</span>
    </div>
  </div>
</template>
