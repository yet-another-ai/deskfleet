<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { ChevronRight } from "@lucide/vue"
import type { OnboardingPermissionsState } from "@deskfleet/client/onboarding"
import UiButton from "./UiButton.vue"

const props = defineProps<{
  state?: OnboardingPermissionsState["auv"]
  pending: boolean
  refreshing: boolean
  disabled?: boolean
  onboarding?: boolean
  error?: string
}>()
defineEmits<{ request: []; refresh: []; advance: [] }>()
const { t } = useI18n()
const status = computed(() => props.pending ? "requesting" : props.state?.status ?? "not-requested")
const saved = computed(() => status.value === "saved")
const busy = computed(() => props.disabled || props.pending || props.refreshing || status.value === "requesting")
</script>

<template>
  <p class="m-0 mt-3 text-sm leading-relaxed text-ui-text-muted">{{ t("auvPermissions.description") }}</p>
  <p class="m-0 mt-3 text-xs leading-relaxed text-ui-text-muted">{{ t("auvPermissions.instructions") }}</p>
  <p role="status" class="m-0 mt-4 text-sm" :class="saved ? 'text-ui-success' : 'text-ui-text-muted'">{{ t(refreshing ? "welcome.checking" : `auvPermissions.status.${status}`) }}</p>
  <p v-if="saved" class="m-0 mt-2 text-xs leading-relaxed text-ui-text-muted">{{ t("auvPermissions.savedHint") }}</p>
  <p v-if="error || state?.error" role="alert" class="m-0 mt-3 break-words text-sm text-ui-danger">{{ error || state?.error }}</p>
  <div class="mt-4 flex flex-wrap gap-2">
    <UiButton :variant="saved ? 'default' : 'primary'" type="button" :disabled="busy" @click="$emit('request')">{{ t(saved ? "auvPermissions.retry" : "auvPermissions.request") }}</UiButton>
    <UiButton type="button" :disabled="disabled || pending || refreshing" @click="$emit('refresh')">{{ t(refreshing ? "welcome.checking" : "welcome.checkAgain") }}</UiButton>
    <UiButton v-if="onboarding && saved" variant="primary" type="button" class="ml-auto" :disabled="busy" @click="$emit('advance')">{{ t("welcome.continue") }}<ChevronRight :size="15" aria-hidden="true" /></UiButton>
  </div>
  <template v-if="onboarding && !saved">
    <p class="m-0 mt-5 text-xs leading-relaxed text-ui-text-muted">{{ t("auvPermissions.skip") }}</p>
    <button type="button" class="mt-3 w-fit cursor-pointer border-0 bg-transparent p-0 text-sm text-ui-text-muted underline underline-offset-4 disabled:cursor-default disabled:opacity-50" :disabled="busy" @click="$emit('advance')">{{ t("welcome.skip") }}</button>
  </template>
</template>
