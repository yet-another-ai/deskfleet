<script setup lang="ts">
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
    <div v-for="permission in pending" :key="permission.id" class="rounded-xl border border-ui-border bg-ui-surface p-3 shadow-ui-card" :data-permission-id="permission.id">
      <p class="m-0 mb-1 flex items-center gap-1.5 text-[13px] font-medium"><ShieldAlert :size="15" :stroke-width="1.75" class="text-ui-warning" aria-hidden="true" />{{ t('agent.permissionRequired') }}</p>
      <AgentToolCall :tool="permission.request.toolCall" live class="pl-2" />
      <div class="mt-2 flex flex-wrap justify-end gap-2">
        <button v-for="option in permission.request.options" :key="option.optionId" type="button" class="inline-flex h-7 cursor-pointer items-center rounded-md px-3 text-[13px] disabled:cursor-default disabled:opacity-50" :class="option.kind.startsWith('allow') ? 'bg-ui-action text-ui-action-text' : 'border border-ui-border hover:bg-ui-hover'" :disabled="disabled" @click="emit('respond', permission.id, option.optionId)">{{ option.name }}</button>
      </div>
    </div>
  </section>
</template>
