<script setup lang="ts">
import { Circle, CircleCheck, CircleDot, CircleX } from "@lucide/vue"
import { computed } from "vue"
import { useI18n } from "vue-i18n"
const props = defineProps<{ entries: { content: string; status: string; _meta?: Record<string, unknown> | null }[] }>()
const { t } = useI18n()
const displayed = computed(() => props.entries.map(entry => {
  const cursor = entry._meta?.cursor
  return cursor && typeof cursor === "object" && "status" in cursor && cursor.status === "cancelled"
    ? { ...entry, status: "cancelled" } : entry
}))
</script>

<template>
  <div class="text-sm">
    <p class="m-0 mb-1.5 text-ui-text-muted">{{ t('agent.plan') }}</p>
    <ol class="flex flex-col gap-1">
      <li v-for="(item, index) in displayed" :key="index" :data-plan-status="item.status" class="flex items-start gap-2" :class="['completed', 'cancelled'].includes(item.status) && 'text-ui-text-muted'">
        <CircleX v-if="item.status === 'cancelled'" :size="15" :stroke-width="1.75" class="mt-0.5 shrink-0" aria-hidden="true" />
        <CircleCheck v-else-if="item.status === 'completed'" :size="15" :stroke-width="1.75" class="mt-0.5 shrink-0 text-ui-success" aria-hidden="true" />
        <CircleDot v-else-if="item.status === 'in_progress'" :size="15" :stroke-width="1.75" class="mt-0.5 shrink-0 text-ui-focus" aria-hidden="true" />
        <Circle v-else :size="15" :stroke-width="1.75" class="mt-0.5 shrink-0 text-ui-text-faint" aria-hidden="true" />
        <span class="select-text" :class="['completed', 'cancelled'].includes(item.status) && 'line-through'">{{ item.content }}</span>
        <span v-if="item.status === 'cancelled'" class="text-xs">{{ t('agent.protocol.planCancelled') }}</span>
      </li>
    </ol>
  </div>
</template>
