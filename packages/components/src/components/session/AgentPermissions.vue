<script setup lang="ts">
import UiButton from "../common/UiButton.vue"
import { ShieldAlert } from "@lucide/vue"
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import type { AgentPermission } from "../../../../../apps/daemon/src/agent-protocol.ts"
import AgentToolCall from "./AgentToolCall.vue"
const props = defineProps<{ permissions: AgentPermission[]; disabled: boolean }>()
const emit = defineEmits<{ respond: [id: string, optionId: string] }>()
const { t } = useI18n()
// Answered requests are recorded on their tool call in the conversation.
const pending = computed(() => props.permissions.filter(permission => permission.state === "pending"))
</script>

<template>
  <section v-if="pending.length" class="flex flex-col gap-2" :aria-label="t('agent.permissions')">
    <div v-for="permission in pending" :key="permission.id" class="rounded-xl border border-ui-warning/40 bg-ui-surface p-3 shadow-ui-card" :data-permission-id="permission.id">
      <p class="m-0 mb-1 flex items-center gap-1.5 text-[13px] font-medium"><ShieldAlert :size="15" :stroke-width="1.75" class="text-ui-warning" aria-hidden="true" />{{ t('agent.permissionRequired') }}</p>
      <AgentToolCall :tool="permission.request.toolCall" live class="pl-2" />
      <div class="mt-2 flex flex-wrap justify-end gap-2">
        <UiButton v-for="option in permission.request.options" :key="option.optionId" :variant="option.kind.startsWith('allow') ? 'primary' : 'default'" :disabled="disabled" @click="emit('respond', permission.id, option.optionId)">{{ option.name }}</UiButton>
      </div>
    </div>
  </section>
</template>
