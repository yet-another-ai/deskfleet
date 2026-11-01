<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { ChevronRight } from "@lucide/vue"
import type { WindowsDesktopServiceState } from "@deskfleet/client/windows-desktop-service"
import UiButton from "../common/UiButton.vue"

const props = defineProps<{
  service?: WindowsDesktopServiceState
  pending: boolean
  refreshing: boolean
  error?: string
}>()
defineEmits<{ request: []; refresh: []; advance: [] }>()
const { t } = useI18n()
const busy = computed(() => props.pending || props.refreshing)
const running = computed(() => props.service?.running === true)
const status = computed(() => props.pending ? "requesting" : props.refreshing || !props.service ? "checking"
  : !props.service.available ? "unavailable" : props.service.running ? "running" : props.service.installed ? "stopped" : "disabled")
</script>

<template>
  <p class="m-0 mt-3 text-sm leading-relaxed text-ui-text-muted">{{ t("welcome.windowsDesktopService.description") }}</p>
  <div class="my-6 rounded-lg border border-ui-border bg-ui-sidebar p-4">
    <p class="m-0 text-xs font-medium">{{ t("welcome.windowsDesktopService.detailsTitle") }}</p>
    <p class="m-0 mt-2 text-sm leading-relaxed text-ui-text-muted">{{ t("welcome.windowsDesktopService.details") }}</p>
  </div>
  <p role="status" class="m-0 mb-4 text-sm" :class="running ? 'text-ui-text' : 'text-ui-text-muted'">{{ t(`welcome.windowsDesktopService.status.${status}`) }}</p>
  <p v-if="error" role="alert" class="m-0 mb-4 break-words text-sm text-ui-danger">{{ error }}</p>
  <div class="flex flex-wrap gap-2">
    <UiButton v-if="!running && service?.available" variant="primary" type="button" :disabled="busy" @click="$emit('request')">{{ t(service.installed ? "welcome.windowsDesktopService.start" : "welcome.windowsDesktopService.enable") }}</UiButton>
    <UiButton type="button" :disabled="busy" @click="$emit('refresh')">{{ t(refreshing ? "welcome.checking" : "welcome.checkAgain") }}</UiButton>
    <UiButton v-if="running" variant="primary" type="button" class="ml-auto" :disabled="busy" @click="$emit('advance')">{{ t("welcome.continue") }}<ChevronRight :size="15" aria-hidden="true" /></UiButton>
  </div>
  <template v-if="!running">
    <p class="m-0 mt-5 text-xs leading-relaxed text-ui-text-muted">{{ t("welcome.windowsDesktopService.skip") }}</p>
    <button type="button" class="mt-3 w-fit cursor-pointer border-0 bg-transparent p-0 text-sm text-ui-text-muted underline underline-offset-4 disabled:cursor-default disabled:opacity-50" :disabled="busy" @click="$emit('advance')">{{ t("welcome.skip") }}</button>
  </template>
</template>
