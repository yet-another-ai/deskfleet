<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { UserRound } from "@lucide/vue"
import type { AgentAuthStatus } from "../../../../client/src/agent-live.ts"

const props = defineProps<{ status: AgentAuthStatus }>()
const { t } = useI18n()
const account = computed(() => [props.status.account?.email, props.status.account?.organization, props.status.account?.plan].filter(Boolean).join(" · "))
</script>

<template>
  <div class="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ui-text-muted" role="status" :aria-label="t('agent.protocol.authentication')" data-testid="agent-auth-status">
    <UserRound :size="14" :stroke-width="1.75" aria-hidden="true" />
    <span :class="status.kind === 'none' && 'text-ui-warning'">{{ status.label }}</span>
    <span v-if="account">{{ account }}</span>
    <span v-if="status.detail" class="text-ui-text-faint">{{ status.detail }}</span>
  </div>
</template>
