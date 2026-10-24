<script setup lang="ts">
import { ArrowUp, Check, ChevronDown, CornerDownRight, Folder, FolderOpen, GitBranch, Monitor, Square } from "@lucide/vue"
import { onClickOutside, useTextareaAutosize } from "@vueuse/core"
import { computed, ref, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"
import { RouterLink } from "vue-router"
import type { AgentSessionContext } from "../../../../../../daemon/src/agent-protocol.ts"
import type { AgentSessionSummary, WorktreeSummary } from "../../stores/fleet-types.ts"
import type { WorkspaceLocation } from "../../stores/fleet.ts"
import AgentConfigurationSelector from "./AgentConfigurationSelector.vue"
const configurationLoading = ref(false)
const props = defineProps<{
  location: (WorkspaceLocation & { session?: AgentSessionSummary; worktree?: WorktreeSummary }) | null
  showTarget?: boolean
  disabled?: boolean
  submitting?: boolean
  activeTurn?: boolean
  canSteer?: boolean
  /** Whether the empty composer offers to cancel the active turn. */
  canCancel?: boolean
}>()
const draft = defineModel<string>({ default: "" })
/** The execution context a new Session will use; only offered with `showTarget`. */
const context = defineModel<AgentSessionContext>("context", { default: "worktree" })
const emit = defineEmits<{ submit: [delivery: "backlog" | "steer"]; cancel: [] }>()
const { t } = useI18n()
const textarea = useTemplateRef<HTMLTextAreaElement>("textarea")
useTextareaAutosize({ element: textarea, input: draft })
const empty = computed(() => !draft.value.trim())
const placeholder = computed(() => t(props.activeTurn ? "agent.backlogHint" : "composer.placeholder"))
const checkout = computed(() => props.location?.worktree?.directories.find(directory => directory.git)?.git ?? undefined)
const changes = computed(() => (checkout.value?.changes ?? []).reduce((total, change) => ({ additions: total.additions + change.additions, deletions: total.deletions + change.deletions }), { additions: 0, deletions: 0 }))
const contexts = [
  { id: "worktree", icon: GitBranch },
  { id: "directory", icon: FolderOpen },
] as const satisfies readonly { id: AgentSessionContext; icon: unknown }[]
const selected = computed(() => contexts.find(option => option.id === context.value) ?? contexts[0])
const picker = useTemplateRef<HTMLElement>("picker")
const choosing = ref(false)
onClickOutside(picker, () => { choosing.value = false })
function choose(value: AgentSessionContext): void {
  context.value = value
  choosing.value = false
}
function submit(delivery: "backlog" | "steer"): void {
  if (props.disabled || props.submitting || configurationLoading.value || !props.location || empty.value) return
  emit("submit", delivery)
}
function keydown(event: KeyboardEvent): void {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit("backlog") }
}
</script>

<template>
  <div class="mx-auto flex w-full max-w-3xl shrink-0 flex-col gap-2 px-6 pb-5">
    <div v-if="location" class="flex h-9 min-w-0 items-center gap-3 rounded-xl border border-ui-border bg-ui-surface px-3 text-[13px] text-ui-text-muted" role="group" :aria-label="t('composer.context')">
      <span class="inline-flex min-w-0 items-center gap-1.5" data-composer-context><Monitor :size="15" :stroke-width="1.75" class="shrink-0" aria-hidden="true" /><span class="truncate">{{ location.machine.name }}</span><span v-if="showTarget && location.machine.local" class="ui-badge">{{ t("machine.local") }}</span></span>
      <span class="h-4 w-px shrink-0 bg-ui-border" aria-hidden="true" />
      <span class="inline-flex min-w-0 items-center gap-1.5" data-composer-context><Folder :size="15" :stroke-width="1.75" class="shrink-0" aria-hidden="true" /><span class="truncate">{{ location.workspace.name }}</span></span>
      <template v-if="showTarget">
        <span class="h-4 w-px shrink-0 bg-ui-border" aria-hidden="true" />
        <div ref="picker" class="relative min-w-0">
          <button type="button" class="inline-flex h-7 min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-ui-text hover:bg-ui-hover" :aria-label="t('composer.contextChoice', { context: t(`composer.contextOption.${selected.id}`) })" aria-haspopup="menu" :aria-expanded="choosing" data-composer-context @click="choosing = !choosing">
            <component :is="selected.icon" :size="15" :stroke-width="1.75" class="shrink-0 text-ui-text-muted" aria-hidden="true" /><span class="truncate">{{ t(`composer.contextOption.${selected.id}`) }}</span><ChevronDown :size="14" :stroke-width="2" class="shrink-0 text-ui-text-muted" aria-hidden="true" />
          </button>
          <div v-if="choosing" role="menu" class="absolute bottom-full left-0 z-20 mb-1 flex w-72 flex-col rounded-lg border border-ui-border bg-ui-surface p-1 shadow-ui-card">
            <button v-for="option in contexts" :key="option.id" type="button" role="menuitemradio" :aria-checked="option.id === context" class="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-ui-hover" @click="choose(option.id)">
              <component :is="option.icon" :size="15" :stroke-width="1.75" class="mt-0.5 shrink-0 text-ui-text-muted" aria-hidden="true" />
              <span class="min-w-0 flex-1"><span class="block text-[13px] text-ui-text">{{ t(`composer.contextOption.${option.id}`) }}</span><span class="block text-xs text-ui-text-muted">{{ t(`composer.contextHint.${option.id}`) }}</span></span>
              <Check v-if="option.id === context" :size="15" :stroke-width="2" class="mt-0.5 shrink-0" aria-hidden="true" />
            </button>
          </div>
        </div>
      </template>
      <template v-else-if="location.worktree">
        <span class="h-4 w-px shrink-0 bg-ui-border" aria-hidden="true" />
        <RouterLink :to="{ name: 'worktree', params: { worktreeId: location.worktree.id } }" class="inline-flex min-w-0 items-center gap-1.5 rounded-md text-ui-text hover:underline" :title="t(location.session?.context === 'directory' ? 'session.directory' : 'session.worktree')" data-composer-context>
          <FolderOpen v-if="location.session?.context === 'directory'" :size="15" :stroke-width="1.75" class="shrink-0 text-ui-text-muted" aria-hidden="true" />
          <GitBranch v-else :size="15" :stroke-width="1.75" class="shrink-0 text-ui-text-muted" aria-hidden="true" />
          <span class="truncate">{{ checkout?.branch ?? t(location.session?.context === 'directory' ? 'session.directory' : 'session.worktree') }}</span>
        </RouterLink>
      </template>
      <span v-if="changes.additions || changes.deletions" class="ml-auto shrink-0 rounded-md bg-ui-badge px-1.5 font-mono text-xs leading-5"><span class="text-ui-success">+{{ changes.additions }}</span> <span class="text-ui-danger">−{{ changes.deletions }}</span></span>
    </div>
    <div class="rounded-2xl border border-ui-border bg-ui-surface shadow-ui-card focus-within:border-ui-text-faint">
      <textarea ref="textarea" v-model="draft" rows="2" class="block max-h-60 min-h-14 w-full resize-none bg-transparent px-4 pt-3 text-[15px] leading-6 outline-none select-text placeholder:text-ui-text-faint" :aria-label="t('composer.label')" :placeholder="placeholder" @keydown="keydown" />
      <div class="flex items-center gap-2 px-3 pb-2.5">
        <AgentConfigurationSelector v-if="location" :workspace-id="location.workspace.id" :session-id="location.session?.id" :disabled="disabled || submitting || activeTurn" @loading="configurationLoading = $event" />
        <button v-if="canSteer && !empty" type="button" class="ui-text-button ml-auto cursor-pointer hover:bg-ui-hover hover:text-ui-text disabled:cursor-default disabled:opacity-50" :disabled="disabled || submitting || configurationLoading" @click="submit('steer')"><CornerDownRight :size="14" :stroke-width="1.75" aria-hidden="true" />{{ t('agent.steer') }}</button>
        <button v-if="canCancel && empty" type="button" class="ml-auto inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-ui-action text-ui-action-text" :title="t('agent.cancelTurn')" :aria-label="t('agent.cancelTurn')" @click="emit('cancel')"><Square :size="12" :stroke-width="0" fill="currentColor" aria-hidden="true" /></button>
        <button v-else type="button" class="inline-flex h-8 w-8 items-center justify-center rounded-full bg-ui-action text-ui-action-text disabled:cursor-default disabled:bg-ui-action-disabled disabled:text-ui-action-text" :class="!(canSteer && !empty) && 'ml-auto'" :title="t(activeTurn ? 'agent.addToBacklog' : 'composer.send')" :aria-label="t(activeTurn ? 'agent.addToBacklog' : 'composer.send')" :disabled="disabled || submitting || configurationLoading || !location || empty" @click="submit('backlog')"><ArrowUp :size="17" :stroke-width="2" aria-hidden="true" /></button>
      </div>
    </div>
  </div>
</template>
