<script setup lang="ts">
import UiButton from "../common/UiButton.vue"
import { usePlatformClient } from "../../composables/usePlatformClient.ts"

import { ArrowLeft } from "@lucide/vue"
import { useEventListener } from "@vueuse/core"
import { useI18n } from "vue-i18n"

const platformClient = usePlatformClient()

defineProps<{ wide?: boolean }>()
const emit = defineEmits<{ back: [] }>()
const { t } = useI18n()
const platform = platformClient.platform

function leaveOnEscape(event: KeyboardEvent): void {
  if (event.defaultPrevented || document.querySelector("dialog[open]")) return
  if (event.key === "Escape") emit("back")
}
useEventListener(window, "keydown", leaveOnEscape)
</script>

<template>
  <!-- Settings replaces the application panes; narrow screens put section links above the content. -->
  <div class="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
    <nav :aria-label="t('settings.sections')" class="flex w-full shrink-0 flex-col border-b border-ui-border bg-ui-sidebar pb-2 md:w-65 md:border-b-0 md:border-r md:pb-0">
      <!-- On macOS the traffic lights sit at the start of this row. -->
      <div class="app-drag flex h-12 shrink-0 items-center pr-2" :class="platform === 'darwin' ? 'pl-20' : 'pl-2'">
        <UiButton variant="ghost" size="sm" type="button" class="cursor-pointer hover:bg-ui-hover hover:text-ui-text" @click="emit('back')">
          <ArrowLeft :size="16" :stroke-width="1.75" aria-hidden="true" />
          {{ t("settings.back") }}
        </UiButton>
      </div>
      <div class="flex gap-0.5 overflow-x-auto px-2 [&>*]:shrink-0 md:flex-col">
        <slot name="nav" />
      </div>
    </nav>
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <div class="app-drag titlebar-overlay-inset hidden h-12 shrink-0 md:block" />
      <div class="min-h-0 flex-1 overflow-y-auto px-4 pb-10 pt-6 sm:px-5 md:px-8 md:pt-0 lg:px-14">
        <div class="mx-auto" :class="wide ? 'max-w-6xl' : 'max-w-3xl'">
          <slot />
        </div>
      </div>
    </div>
  </div>
</template>
