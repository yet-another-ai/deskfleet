<script setup lang="ts">
import { vNavigationMotion } from "../../directives/navigation-motion.ts"
import type { NavigationTransition } from "../../services/navigation-motion.ts"
import UiButton from "../common/UiButton.vue"
import UiScrollArea from "../common/UiScrollArea.vue"
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import { useScrollFade } from "../../composables/useScrollFade.ts"

import { ArrowLeft } from "@lucide/vue"
import { useEventListener } from "@vueuse/core"
import { useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"

const platformClient = usePlatformClient()

defineProps<{ wide?: boolean; motion?: NavigationTransition }>()
const emit = defineEmits<{ back: [] }>()
const { t } = useI18n()
const platform = platformClient.platform
const navScroller = useTemplateRef<HTMLElement>("navScroller")
const { fadeStyle: navFadeStyle } = useScrollFade(navScroller, { fade: "both", size: "sm" })

function leaveOnEscape(event: KeyboardEvent): void {
  if (event.defaultPrevented || document.querySelector('dialog[open], [data-dismissable-layer]:not([data-state="closed"]):not(:has([role="tooltip"]))')) return
  if (event.key === "Escape") emit("back")
}
useEventListener(window, "keydown", leaveOnEscape)
</script>

<template>
  <!-- Settings replaces the application panes; narrow screens put section links above the content. -->
  <div class="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
    <nav :aria-label="t('settings.sections')" class="flex w-full shrink-0 flex-col border-b border-ui-border bg-ui-sidebar pb-2 pt-[var(--safe-area-top,0px)] md:w-65 md:border-b-0 md:border-r md:pb-0">
      <!-- On macOS the traffic lights sit at the start of this row. -->
      <div class="app-drag flex h-12 shrink-0 items-center pr-2" :class="platform === 'darwin' ? 'pl-24' : 'pl-2'">
        <UiButton variant="ghost" size="sm" type="button" class="cursor-pointer hover:bg-ui-hover hover:text-ui-text" @click="emit('back')">
          <ArrowLeft :size="16" :stroke-width="1.75" aria-hidden="true" />
          {{ t("settings.back") }}
        </UiButton>
      </div>
      <div class="ui-scroll-mask min-h-0 min-w-0" :style="navFadeStyle">
        <div ref="navScroller" class="flex gap-0.5 overflow-x-auto px-2 [&>*]:shrink-0 md:flex-col md:overflow-y-auto">
          <slot name="nav" />
        </div>
      </div>
    </nav>
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <div class="app-drag titlebar-overlay-inset hidden h-12 shrink-0 md:block" />
      <UiScrollArea class="min-h-0 flex-1" viewport-class="px-4 pb-[calc(2.5rem+var(--safe-area-bottom,0px))] pt-6 sm:px-5 md:px-8 md:pt-0 lg:px-14">
        <div v-navigation-motion="motion" class="mx-auto" :class="wide ? 'max-w-6xl' : 'max-w-3xl'">
          <slot />
        </div>
      </UiScrollArea>
    </div>
  </div>
</template>
