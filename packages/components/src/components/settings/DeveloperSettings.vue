<script setup lang="ts">
import type { NatTestResult } from "@deskfleet/client/network-diagnostics"
import { LoaderCircle, Network } from "@lucide/vue"
import { useAsyncState } from "@vueuse/core"
import { computed, useId } from "vue"
import { useI18n } from "vue-i18n"
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import UiButton from "../common/UiButton.vue"

const { t } = useI18n()
const id = useId()
const diagnostics = usePlatformClient().networkDiagnostics
const { state: result, isLoading: testing, error, executeImmediate } = useAsyncState<NatTestResult | null, []>(
  async () => {
    if (!diagnostics) throw new Error(t("developerSettings.desktopRequired"))
    return diagnostics.testNat()
  },
  null,
  { immediate: false },
)
const natType = computed(() => {
  if (!result.value) return "unknown"
  const { mapping, filtering } = result.value
  if (mapping === "address-dependent" || mapping === "address-and-port-dependent") return "symmetric"
  if (filtering === "unknown") return "unknown"
  if (mapping === "direct") return filtering === "endpoint-independent" ? "open" : "firewall"
  if (mapping !== "endpoint-independent") return "unknown"
  if (filtering === "endpoint-independent") return "fullCone"
  return filtering === "address-dependent" ? "restrictedCone" : "portRestrictedCone"
})
const errorMessage = computed(() => error.value instanceof Error ? error.value.message : String(error.value))

function testNat(): void {
  if (diagnostics && !testing.value) void executeImmediate()
}
</script>

<template>
  <h1 class="ui-page-title mb-6">{{ t("developerSettings.title") }}</h1>
  <section :aria-labelledby="`${id}-title`">
    <h2 :id="`${id}-title`" class="ui-section-title mb-2 flex items-center gap-2">
      <Network :size="17" :stroke-width="1.75" aria-hidden="true" />
      {{ t("developerSettings.natTitle") }}
    </h2>
    <p class="m-0 mb-4 text-[13px] text-ui-text-muted">{{ t("developerSettings.description") }}</p>
    <p v-if="!diagnostics" class="ui-card m-0 p-4 text-sm text-ui-text-muted">{{ t("developerSettings.desktopRequired") }}</p>
    <template v-else>
      <div class="ui-card flex flex-col gap-3 p-4">
        <div class="flex flex-wrap items-center gap-3">
          <UiButton variant="primary" type="button" :disabled="testing" @click="testNat">
            <LoaderCircle v-if="testing" :size="14" class="animate-spin" aria-hidden="true" />
            {{ t(testing ? "developerSettings.testing" : "developerSettings.test") }}
          </UiButton>
          <span v-if="testing" role="status" class="text-[13px] text-ui-text-muted">{{ t("developerSettings.testingHelp") }}</span>
        </div>
        <p v-if="error" role="alert" class="m-0 break-words text-sm text-ui-danger">{{ errorMessage }}</p>
      </div>
      <div v-if="result" class="ui-card mt-4 p-4" role="status" aria-live="polite">
        <p class="m-0 mb-1 text-xs text-ui-text-muted">{{ t("developerSettings.result") }}</p>
        <h3 class="m-0 text-base font-semibold">{{ t(`developerSettings.types.${natType}`) }}</h3>
        <p class="m-0 mt-2 text-[13px] text-ui-text-muted">{{ t(`developerSettings.status.${result.status}`) }}</p>
        <dl class="m-0 mt-4 grid grid-cols-1 gap-x-6 gap-y-2 border-t border-ui-border pt-4 text-[13px] sm:grid-cols-[auto_1fr]">
          <dt class="text-ui-text-muted">{{ t("developerSettings.mapping") }}</dt>
          <dd class="m-0">{{ t(`developerSettings.behavior.${result.mapping}`) }}</dd>
          <dt class="text-ui-text-muted">{{ t("developerSettings.filtering") }}</dt>
          <dd class="m-0">{{ t(`developerSettings.behavior.${result.filtering}`) }}</dd>
          <dt class="text-ui-text-muted">{{ t("developerSettings.localAddress") }}</dt>
          <dd class="m-0 break-all font-mono">{{ result.localAddress }}</dd>
          <dt class="text-ui-text-muted">{{ t("developerSettings.publicAddress") }}</dt>
          <dd class="m-0 break-all font-mono">{{ result.publicAddress ?? "—" }}</dd>
          <dt class="text-ui-text-muted">{{ t("developerSettings.server") }}</dt>
          <dd class="m-0 break-all font-mono">{{ result.server }}</dd>
          <dt class="text-ui-text-muted">{{ t("developerSettings.duration") }}</dt>
          <dd class="m-0">{{ t("developerSettings.milliseconds", { value: result.durationMs }) }}</dd>
        </dl>
        <p class="m-0 mt-4 text-xs text-ui-text-muted">{{ t("developerSettings.resultHelp") }}</p>
      </div>
    </template>
  </section>
</template>
