<script setup lang="ts">
import { Archive, Hand, LoaderCircle, ShieldCheck } from "@lucide/vue"
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import type { SessionActivity } from "../../services/agent-conversation.ts"

const { state = "working" } = defineProps<{ state?: SessionActivity | "archiving" | false }>()
const { t } = useI18n()
const label = computed(() => t(
  state === "archiving"
    ? "agent.archiving"
    : state === "permission"
      ? "agent.permissionRequired"
      : state === "question"
        ? "agent.questions.title"
        : "agent.working",
))
</script>

<template>
  <span class="inline-flex shrink-0 items-center text-ui-text-muted" role="status" :title="label" :data-session-working="state">
    <Archive v-if="state === 'archiving'" :size="14" :stroke-width="2" class="animate-pulse" aria-hidden="true" />
    <ShieldCheck v-else-if="state === 'permission'" :size="14" :stroke-width="2" class="animate-bounce" aria-hidden="true" />
    <Hand v-else-if="state === 'question'" :size="14" :stroke-width="2" class="animate-bounce" aria-hidden="true" />
    <LoaderCircle v-else :size="14" :stroke-width="2" class="animate-spin" aria-hidden="true" />
    <span class="sr-only">{{ label }}</span>
  </span>
</template>
