<script setup lang="ts">
import { computed, watch } from "vue"
import { useAsyncState, useEventListener } from "@vueuse/core"
import { useI18n } from "vue-i18n"
import type { AgentSnapshot } from "../../../../../apps/daemon/src/agent-protocol.ts"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import UiButton from "../common/UiButton.vue"
const props = defineProps<{ snapshot: AgentSnapshot }>()
const account = useAccountSession()
const { t } = useI18n()
const { state, executeImmediate } = useAsyncState(async () => account?.teamId.value ? account.central.billing(account.teamId.value) : undefined, undefined)
watch(() => account?.teamId.value, () => { void executeImmediate() })
useEventListener(window, "focus", () => { void executeImmediate() })
const used = computed(() => (props.snapshot.session.inheritedTurnCount ?? 0) + props.snapshot.turns.filter(turn => turn.consumed).length)
</script>
<template>
  <div v-if="state?.limits.maxTurnsPerSession != null || snapshot.session.turnLimitReason" class="grid gap-2 rounded-lg border border-ui-border p-3 text-xs">
    <p v-if="state?.limits.maxTurnsPerSession != null" class="m-0 text-ui-text-muted">{{ t("billing.sessionTurns", { used, limit: state.limits.maxTurnsPerSession }) }} <span v-if="snapshot.session.inheritedTurnCount">{{ t("billing.inheritedTurns", { count: snapshot.session.inheritedTurnCount }) }}</span></p>
    <p v-if="snapshot.session.turnLimitReason" role="status" class="m-0 text-ui-text-muted">{{ snapshot.session.turnLimitReason }} {{ t("billing.resumeHint") }}</p>
    <UiButton v-if="account" size="sm" class="justify-self-start" @click="account.openSettings('team')">{{ t("team.plansUsage") }}</UiButton>
  </div>
</template>
