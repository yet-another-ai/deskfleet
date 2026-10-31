<script setup lang="ts">
import { CircleAlert, ChevronRight } from "@lucide/vue"
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import type { RelayDeniedReason } from "@deskfleet/client/relay"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import { errorPresentation } from "../../services/error-presentation.ts"
import UiButton from "./UiButton.vue"

const props = defineProps<{ error?: unknown; title?: string; description?: string; relayDeniedReason?: RelayDeniedReason }>()
const { t } = useI18n()
const account = useAccountSession()
const presentation = computed(() => errorPresentation(props.error, props.relayDeniedReason))
const relay = computed(() => ["free_plan", "turn_quota_exhausted", "metering_unavailable"].includes(presentation.value.kind))
const title = computed(() => (!relay.value && props.title) || t(`errors.${presentation.value.kind}.title`))
const description = computed(() => !relay.value && props.description !== undefined ? props.description : t(`errors.${presentation.value.kind}.description`))
const detail = computed(() => presentation.value.detail !== title.value && presentation.value.detail !== description.value ? presentation.value.detail : undefined)
</script>

<template>
  <div role="alert" class="min-w-0 rounded-lg border border-ui-danger/25 bg-ui-danger/5 p-3 text-left" data-error-notice>
    <div class="flex items-start gap-2.5">
      <CircleAlert :size="17" :stroke-width="1.75" class="mt-0.5 shrink-0 text-ui-danger" aria-hidden="true" />
      <div class="min-w-0 flex-1">
        <p class="m-0 break-words text-[13px] font-medium text-ui-text">{{ title }}</p>
        <p v-if="description" class="m-0 mt-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ui-text-muted">{{ description }}</p>
        <div v-if="(presentation.billing && account) || $slots.default" class="mt-3 flex flex-wrap items-center gap-2">
          <UiButton v-if="presentation.billing && account" size="sm" @click="account.openSettings('plans')">{{ t("errors.viewBilling") }}</UiButton>
          <slot />
        </div>
        <details v-if="detail" :key="detail" class="group mt-3 text-xs text-ui-text-muted">
          <summary class="flex w-fit cursor-pointer list-none items-center gap-1 rounded-sm hover:text-ui-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-ui-accent">
            <ChevronRight :size="13" class="shrink-0 transition-transform group-open:rotate-90" aria-hidden="true" />{{ t("errors.details") }}
          </summary>
          <pre class="mb-0 mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-ui-canvas/70 p-2 font-mono text-[11px] leading-relaxed" style="overflow-wrap: anywhere">{{ detail }}</pre>
        </details>
      </div>
    </div>
  </div>
</template>
