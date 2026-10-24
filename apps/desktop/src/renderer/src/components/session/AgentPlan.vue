<script setup lang="ts">
import { Circle, CircleCheck, CircleDot } from "@lucide/vue"
import { useI18n } from "vue-i18n"
defineProps<{ entries: { content: string; status: string }[] }>()
const { t } = useI18n()
</script>

<template>
  <div class="text-sm">
    <p class="m-0 mb-1.5 text-ui-text-muted">{{ t('agent.plan') }}</p>
    <ol class="flex flex-col gap-1">
      <li v-for="(item, index) in entries" :key="index" class="flex items-start gap-2" :class="item.status === 'completed' && 'text-ui-text-muted line-through'">
        <CircleCheck v-if="item.status === 'completed'" :size="15" :stroke-width="1.75" class="mt-0.5 shrink-0 text-ui-success" aria-hidden="true" />
        <CircleDot v-else-if="item.status === 'in_progress'" :size="15" :stroke-width="1.75" class="mt-0.5 shrink-0 text-ui-focus" aria-hidden="true" />
        <Circle v-else :size="15" :stroke-width="1.75" class="mt-0.5 shrink-0 text-ui-text-faint" aria-hidden="true" />
        <span class="select-text">{{ item.content }}</span>
      </li>
    </ol>
  </div>
</template>
