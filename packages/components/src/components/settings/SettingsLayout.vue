<script setup lang="ts">
import { client as platformClient } from "@deskfleet/client/platform"

import { ArrowLeft } from "@lucide/vue"
import { onBeforeUnmount, onMounted } from "vue"
import { useI18n } from "vue-i18n"

const emit = defineEmits<{ back: [] }>()
const { t } = useI18n()
const platform = platformClient.platform

function leaveOnEscape(event: KeyboardEvent): void {
  if (event.defaultPrevented || document.querySelector("dialog[open]")) return
  if (event.key === "Escape") emit("back")
}
onMounted(() => window.addEventListener("keydown", leaveOnEscape))
onBeforeUnmount(() => window.removeEventListener("keydown", leaveOnEscape))
</script>

<template>
  <!-- Settings replaces the sidebar and details panel: its sections on the left, the selected one on the right. -->
  <div class="flex min-h-0 flex-1">
    <nav :aria-label="t('settings.sections')" class="flex w-65 shrink-0 flex-col border-r border-ui-border bg-ui-sidebar">
      <!-- On macOS the traffic lights sit at the start of this row. -->
      <div class="app-drag flex h-12 shrink-0 items-center pr-2" :class="platform === 'darwin' ? 'pl-20' : 'pl-2'">
        <button type="button" class="ui-text-button cursor-pointer hover:bg-ui-hover hover:text-ui-text" @click="emit('back')">
          <ArrowLeft :size="16" :stroke-width="1.75" aria-hidden="true" />
          {{ t("settings.back") }}
        </button>
      </div>
      <div class="flex flex-col gap-0.5 px-2">
        <slot name="nav" />
      </div>
    </nav>
    <div class="flex min-w-0 flex-1 flex-col">
      <div class="app-drag titlebar-overlay-inset h-12 shrink-0" />
      <div class="min-h-0 flex-1 overflow-y-auto px-14 pb-10">
        <div class="mx-auto max-w-3xl">
          <slot />
        </div>
      </div>
    </div>
  </div>
</template>
