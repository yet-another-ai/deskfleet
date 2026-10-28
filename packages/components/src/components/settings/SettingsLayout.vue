<script setup lang="ts">
import UiButton from "../common/UiButton.vue"
import { client as platformClient } from "@deskfleet/client/platform"

import { ArrowLeft } from "@lucide/vue"
import { useEventListener } from "@vueuse/core"
import { useI18n } from "vue-i18n"

defineProps<{ stackOnSmallScreens?: boolean; wide?: boolean }>()
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
  <!-- Settings replaces the sidebar and details panel: its sections on the left, the selected one on the right. -->
  <div class="flex min-h-0 flex-1" :class="stackOnSmallScreens && 'flex-col md:flex-row'">
    <nav :aria-label="t('settings.sections')" class="flex shrink-0 flex-col border-ui-border bg-ui-sidebar" :class="stackOnSmallScreens ? 'w-full border-b pb-2 md:w-65 md:border-b-0 md:border-r md:pb-0' : 'w-65 border-r'">
      <!-- On macOS the traffic lights sit at the start of this row. -->
      <div class="app-drag flex h-12 shrink-0 items-center pr-2" :class="platform === 'darwin' ? 'pl-20' : 'pl-2'">
        <UiButton variant="ghost" size="sm" type="button" class="cursor-pointer hover:bg-ui-hover hover:text-ui-text" @click="emit('back')">
          <ArrowLeft :size="16" :stroke-width="1.75" aria-hidden="true" />
          {{ t("settings.back") }}
        </UiButton>
      </div>
      <div class="flex flex-col gap-0.5 px-2">
        <slot name="nav" />
      </div>
    </nav>
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <div class="app-drag titlebar-overlay-inset h-12 shrink-0" :class="stackOnSmallScreens && 'hidden md:block'" />
      <div class="min-h-0 flex-1 overflow-y-auto pb-10" :class="stackOnSmallScreens ? 'px-5 pt-6 md:px-8 md:pt-0 lg:px-14' : 'px-14'">
        <div class="mx-auto" :class="wide ? 'max-w-6xl' : 'max-w-3xl'">
          <slot />
        </div>
      </div>
    </div>
  </div>
</template>
