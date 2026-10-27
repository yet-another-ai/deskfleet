<script setup lang="ts">
import { ref } from "vue"
import { useAsyncState } from "@vueuse/core"
import { useI18n } from "vue-i18n"
import type { SiteAdministrationApi } from "@deskfleet/client/central"
import type { AdminTeamBilling } from "@deskfleet/client/billing"
import UiButton from "../common/UiButton.vue"
const props = defineProps<{ api: SiteAdministrationApi }>()
const { t } = useI18n()
const busy = ref(false)
const actionError = ref("")
const { state, isLoading, error, executeImmediate } = useAsyncState(() => props.api.billingTeams(), [])
async function toggle(team: AdminTeamBilling) {
  busy.value = true; actionError.value = ""
  try { await props.api.setEnterprise(team.id, !team.billing.enterpriseOverride); await executeImmediate() }
  catch (reason) { actionError.value = reason instanceof Error ? reason.message : String(reason) }
  finally { busy.value = false }
}
</script>
<template>
  <section class="mt-8 grid gap-3">
    <div class="flex items-center justify-between gap-3"><h2 class="ui-section-title">{{ t("billing.enterpriseTeams") }}</h2><UiButton :disabled="isLoading || busy" @click="executeImmediate()">{{ t("auth.refresh") }}</UiButton></div>
    <p class="m-0 text-sm text-ui-text-muted">{{ t("billing.enterpriseHint") }}</p>
    <p v-if="error || actionError" role="alert" class="text-sm text-ui-danger">{{ actionError || String(error) }}</p>
    <p v-if="isLoading" role="status">{{ t("auth.loading") }}</p>
    <div v-for="team in state" :key="team.id" class="ui-card flex items-center justify-between gap-4 p-4">
      <div class="min-w-0"><h3 class="m-0 truncate text-sm font-medium">{{ team.name }}</h3><p class="m-0 mt-1 text-xs text-ui-text-muted">{{ t(`billing.plan.${team.billing.plan}`) }}</p></div>
      <UiButton :disabled="busy" @click="toggle(team)">{{ t(team.billing.enterpriseOverride ? "billing.revokeEnterprise" : "billing.grantEnterprise") }}</UiButton>
    </div>
    <a href="/auth/account" class="text-sm">{{ t("auth.confirmIdentity") }}</a>
  </section>
</template>
