<script setup lang="ts">
import { Bot, Check, FolderOpen, Send } from "@lucide/vue"
import { useI18n } from "vue-i18n"
import { RouterLink } from "vue-router"
import UiButton from "../common/UiButton.vue"

defineProps<{
  step: "workspace" | "agent" | "task"
  hasWorkspaces: boolean
  canSetUpAgent: boolean
  suggestTask: boolean
}>()
defineEmits<{ workspace: []; suggest: []; skip: [] }>()

const { t } = useI18n()
const steps = ["workspace", "agent", "task"] as const
const icons = { workspace: FolderOpen, agent: Bot, task: Send }
</script>

<template>
  <div class="ui-card w-full max-w-xl border border-ui-border bg-ui-surface p-4 sm:p-5">
    <ol class="m-0 flex list-none flex-wrap gap-x-5 gap-y-2 p-0 text-xs" :aria-label="t('firstTask.progress')">
      <li v-for="(item, index) in steps" :key="item" class="flex items-center gap-1.5" :aria-current="step === item ? 'step' : undefined" :class="step === item ? 'font-semibold text-ui-text' : 'text-ui-text-muted'">
        <Check v-if="index < steps.indexOf(step)" :size="14" class="text-ui-accent" aria-hidden="true" />
        <component :is="icons[item]" v-else :size="14" aria-hidden="true" />
        {{ t(`firstTask.steps.${item}`) }}
      </li>
    </ol>
    <div class="mt-4 border-t border-ui-border pt-4">
      <h2 class="m-0 text-sm font-semibold">{{ t(`firstTask.${step}.title`) }}</h2>
      <p class="m-0 mt-1.5 text-sm leading-relaxed text-ui-text-muted">
        {{ t(step === 'workspace' && hasWorkspaces ? 'firstTask.workspace.existing' : `firstTask.${step}.description`) }}
      </p>
      <div class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <UiButton v-if="step === 'workspace' && !hasWorkspaces" type="button" variant="primary" @click="$emit('workspace')">{{ t('firstTask.workspace.choose') }}</UiButton>
        <RouterLink v-else-if="step === 'agent' && canSetUpAgent" :to="{ name: 'settings-agents' }" class="ui-button-primary h-8 px-3 no-underline">{{ t('firstTask.agent.setup') }}</RouterLink>
        <UiButton v-else-if="step === 'task' && suggestTask" type="button" @click="$emit('suggest')">{{ t('firstTask.task.suggest') }}</UiButton>
        <UiButton type="button" variant="ghost" size="sm" @click="$emit('skip')">{{ t('firstTask.skip') }}</UiButton>
      </div>
    </div>
  </div>
</template>
