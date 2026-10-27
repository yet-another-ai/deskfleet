<script setup lang="ts">
import UiButton from "../common/UiButton.vue"
import { ArrowUp, Check, ChevronDown, CornerDownRight, Folder, FolderOpen, GitBranch, Monitor, Square } from "@lucide/vue"
import { useTextareaAutosize } from "@vueuse/core"
import { DropdownMenuContent, DropdownMenuPortal, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuRoot, DropdownMenuTrigger } from "reka-ui"
import { computed, ref, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"
import { RouterLink } from "vue-router"
import type { AgentSessionContext } from "../../../../../apps/daemon/src/agent-protocol.ts"
import type { AgentSessionSummary, WorktreeSummary } from "../../stores/fleet-types.ts"
import type { WorkspaceLocation } from "../../stores/fleet.ts"
import AgentConfigurationSelector from "./AgentConfigurationSelector.vue"
import AgentUsage from "./AgentUsage.vue"
import type { AgentUsage as AgentUsageUpdate } from "../../services/agent-usage.ts"
const configurationLoading = ref(false)
const props = defineProps<{
  location: (WorkspaceLocation & { session?: AgentSessionSummary; worktree?: WorktreeSummary }) | null
  showTarget?: boolean
  disabled?: boolean
  submitting?: boolean
  activeTurn?: boolean
  canSteer?: boolean
  usage?: AgentUsageUpdate
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
        <DropdownMenuRoot :modal="false">
          <DropdownMenuTrigger class="inline-flex h-7 min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-ui-text hover:bg-ui-hover" :aria-label="t('composer.contextChoice', { context: t(`composer.contextOption.${selected.id}`) })" data-composer-context>
            <component :is="selected.icon" :size="15" :stroke-width="1.75" class="shrink-0 text-ui-text-muted" aria-hidden="true" /><span class="truncate">{{ t(`composer.contextOption.${selected.id}`) }}</span><ChevronDown :size="14" :stroke-width="2" class="shrink-0 text-ui-text-muted" aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuPortal>
          <DropdownMenuContent side="top" align="start" :side-offset="4" :collision-padding="8" :aria-label="t('composer.context')" class="ui-menu z-50 flex w-72 flex-col" loop>
            <DropdownMenuRadioGroup v-model="context">
            <DropdownMenuRadioItem v-for="option in contexts" :key="option.id" as="button" type="button" :value="option.id" class="ui-menu-item items-start">
              <component :is="option.icon" :size="15" :stroke-width="1.75" class="mt-0.5 shrink-0 text-ui-text-muted" aria-hidden="true" />
              <span class="min-w-0 flex-1"><span class="block text-[13px] text-ui-text">{{ t(`composer.contextOption.${option.id}`) }}</span><span class="block text-xs text-ui-text-muted">{{ t(`composer.contextHint.${option.id}`) }}</span></span>
              <Check v-if="option.id === context" :size="15" :stroke-width="2" class="mt-0.5 shrink-0" aria-hidden="true" />
            </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
          </DropdownMenuPortal>
        </DropdownMenuRoot>
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
    <div class="relative rounded-2xl border border-ui-border bg-ui-surface shadow-ui-card transition-colors focus-within:border-ui-accent/60">
      <span v-if="showTarget && submitting" class="composer-creation-beam" aria-hidden="true" />
      <textarea ref="textarea" v-model="draft" rows="2" class="block max-h-60 min-h-14 w-full resize-none bg-transparent px-4 pt-3 text-[15px] leading-6 outline-none select-text placeholder:text-ui-text-faint" :aria-label="t('composer.label')" :placeholder="placeholder" @keydown="keydown" />
      <div class="flex items-center gap-2 px-3 pb-2.5">
        <AgentConfigurationSelector v-if="location" :workspace-id="location.workspace.id" :session-id="location.session?.id" :disabled="disabled || submitting || activeTurn" @loading="configurationLoading = $event" />
        <div class="ml-auto flex shrink-0 items-center gap-2">
          <AgentUsage v-if="usage" :key="location?.session?.id" :usage="usage" />
          <UiButton variant="ghost" size="sm" v-if="canSteer && !empty" type="button" class="cursor-pointer hover:bg-ui-hover hover:text-ui-text disabled:cursor-default disabled:opacity-50" :disabled="disabled || submitting || configurationLoading" @click="submit('steer')"><CornerDownRight :size="14" :stroke-width="1.75" aria-hidden="true" />{{ t('agent.steer') }}</UiButton>
          <UiButton v-if="canCancel && empty" variant="primary" size="icon" class="h-8 w-8 rounded-full" :title="t('agent.cancelTurn')" :aria-label="t('agent.cancelTurn')" @click="emit('cancel')"><Square :size="12" :stroke-width="0" fill="currentColor" aria-hidden="true" /></UiButton>
          <UiButton v-else variant="primary" size="icon" class="h-8 w-8 rounded-full" :title="t(activeTurn ? 'agent.addToBacklog' : 'composer.send')" :aria-label="t(activeTurn ? 'agent.addToBacklog' : 'composer.send')" :disabled="disabled || submitting || configurationLoading || !location || empty" @click="submit('backlog')"><ArrowUp :size="17" :stroke-width="2" aria-hidden="true" /></UiButton>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
@property --deskfleet-composer-beam-angle {
  syntax: "<angle>";
  initial-value: 0deg;
  inherits: true;
}

.composer-creation-beam {
  --beam-colors:
    radial-gradient(ellipse at 15% 0%, light-dark(#3478d4, #4996ff), transparent 55%),
    radial-gradient(ellipse at 75% 0%, light-dark(#ce753b, #ef8d51), transparent 50%),
    radial-gradient(ellipse at 100% 65%, light-dark(#bf4c9b, #dc6bb8), transparent 50%),
    radial-gradient(ellipse at 60% 100%, light-dark(#7652d5, #9171f8), transparent 55%),
    radial-gradient(ellipse at 0% 80%, light-dark(#259886, #43baa8), transparent 50%);
  position: absolute;
  inset: -1px;
  z-index: 1;
  border-radius: inherit;
  /* Clip the decoration only: the composer's menus must remain free to overflow. */
  overflow: hidden;
  pointer-events: none;
  mask-image: conic-gradient(
    from var(--deskfleet-composer-beam-angle),
    transparent 0% 15%, #000 45% 65%, transparent 95%
  );
  animation: composer-beam-sweep 2.3s linear infinite, composer-beam-appear 180ms ease-out;
}

.composer-creation-beam::before,
.composer-creation-beam::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: var(--beam-colors);
  mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  mask-composite: exclude;
}

.composer-creation-beam::before {
  padding: 1.5px;
  opacity: 0.9;
}

.composer-creation-beam::after {
  padding: 6px;
  filter: blur(6px);
  opacity: 0.3;
}

@keyframes composer-beam-sweep {
  to { --deskfleet-composer-beam-angle: 360deg; }
}

@keyframes composer-beam-appear {
  from { opacity: 0; }
  to { opacity: 1; }
}
</style>
