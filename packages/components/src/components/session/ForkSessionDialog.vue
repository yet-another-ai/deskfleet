<script setup lang="ts">
import { FolderOpen, GitBranch, LoaderCircle } from "@lucide/vue"
import { DialogDescription, DialogTitle, RadioGroupIndicator, RadioGroupItem, RadioGroupRoot } from "reka-ui"
import { computed, ref, useId } from "vue"
import { useI18n } from "vue-i18n"
import type { AgentSessionContext } from "../../../../../apps/daemon/src/agent-protocol.ts"
import UiButton from "../common/UiButton.vue"
import UiDialog from "../common/UiDialog.vue"

const props = withDefaults(defineProps<{
  context: AgentSessionContext
  disabled: boolean
  retrying: boolean
  /** Machine-scoped Sessions can only fork into directory context. */
  allowWorktree?: boolean
  confirm(context: AgentSessionContext): Promise<void>
}>(), { allowWorktree: true })
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const id = useId()
const context = ref(props.allowWorktree ? props.context : "directory" as const)
const pending = ref(false)
const error = ref<string>()
const contexts = computed(() => {
  const options = [{ id: "worktree" as const, icon: GitBranch }, { id: "directory" as const, icon: FolderOpen }]
  return props.allowWorktree ? options : options.filter(option => option.id === "directory")
})

function cancel(): void { if (!pending.value) emit("close") }
async function submit(): Promise<void> {
  if (pending.value || props.disabled) return
  pending.value = true
  error.value = undefined
  try {
    await props.confirm(context.value)
    emit("close")
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { pending.value = false }
}
</script>

<template>
  <UiDialog class="w-[28rem]" described :prevent-close="pending" @close="cancel">
    <DialogTitle class="ui-dialog-title">{{ t('agent.fork') }}</DialogTitle>
    <DialogDescription class="ui-dialog-description">{{ t('agent.forkDescription') }}</DialogDescription>
    <fieldset class="m-0 mt-5 border-0 p-0">
      <legend class="mb-2 text-xs font-medium text-ui-text-muted">{{ t('composer.context') }}</legend>
      <RadioGroupRoot v-model="context" :name="`${id}-context`" :aria-label="t('composer.context')" :disabled="pending || retrying" class="flex flex-col gap-2">
        <RadioGroupItem v-for="option in contexts" :key="option.id" :value="option.id" class="flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-left disabled:cursor-default disabled:op-50" :class="context === option.id ? 'border-ui-accent bg-ui-hover' : 'border-ui-border'">
          <span class="mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-ui-border-strong"><RadioGroupIndicator class="h-2 w-2 rounded-full bg-ui-accent" /></span>
          <component :is="option.icon" :size="16" class="mt-0.5 shrink-0 text-ui-text-muted" aria-hidden="true" />
          <span class="min-w-0"><span class="block text-sm">{{ t(`composer.contextOption.${option.id}`) }}</span><span class="mt-1 block text-xs text-ui-text-muted">{{ t(`composer.contextHint.${option.id}`) }}</span></span>
        </RadioGroupItem>
      </RadioGroupRoot>
    </fieldset>
    <p v-if="pending" role="status" class="mb-0 mt-4 flex items-center gap-2 text-sm text-ui-text-muted"><LoaderCircle :size="14" class="animate-spin" aria-hidden="true" />{{ t('agent.forking') }}</p>
    <p v-if="error" role="alert" class="mb-0 mt-4 text-sm text-ui-danger">{{ error }}</p>
    <div class="ui-dialog-actions">
      <UiButton type="button" :disabled="pending" @click="cancel">{{ t('catalog.cancel') }}</UiButton>
      <UiButton variant="primary" type="button" :disabled="pending || disabled" @click="submit">{{ t(retrying ? 'agent.checkResult' : 'agent.fork') }}</UiButton>
    </div>
  </UiDialog>
</template>
