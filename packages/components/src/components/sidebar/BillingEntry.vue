<script setup lang="ts">
import { Sparkles } from "@lucide/vue"
import { useI18n } from "vue-i18n"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import { useTeamBilling } from "../../composables/useTeamBilling.ts"
import { trackEvent } from "../../services/analytics.ts"

const account = useAccountSession()!
const { t } = useI18n()
const { billing, canUpgrade } = useTeamBilling(account)

function open(): void {
  trackEvent("billing_entry_clicked", { source: "sidebar", current_plan: billing.value?.plan, action: "upgrade" })
  account.openSettings("plans")
}
</script>

<template>
  <div v-if="canUpgrade" class="shrink-0 px-2 pb-1.5" data-billing-entry>
    <button
      type="button"
      class="ui-nav-item w-full bg-ui-accent/10 px-2.5 text-ui-accent hover:bg-ui-accent/18 hover:text-ui-accent active:bg-ui-accent/22"
      @click="open"
    >
      <Sparkles :size="15" :stroke-width="1.75" class="shrink-0" aria-hidden="true" />
      <span class="min-w-0 flex-1 truncate text-left font-medium">{{ t("billing.upgradePlan") }}</span>
    </button>
  </div>
</template>
