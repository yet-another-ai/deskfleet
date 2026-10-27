<script setup lang="ts">
import { client } from "@deskfleet/client/platform"
import UiButton from "../common/UiButton.vue"
import FilePickerDialog from "../common/FilePickerDialog.vue"
import UiCheckbox from "../common/UiCheckbox.vue"
import { ArrowUp, Check, ChevronDown, CornerDownRight, File, FileText, Folder, FolderOpen, GitBranch, HardDrive, MessageSquare, Monitor, Plus, Sparkles, Square, Upload, X } from "@lucide/vue"
import { useDropZone, useTextareaAutosize } from "@vueuse/core"
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuRoot, DropdownMenuTrigger } from "reka-ui"
import { computed, reactive, ref, useId, useTemplateRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import { RouterLink } from "vue-router"
import type { AgentSessionContext } from "../../../../../apps/daemon/src/agent-protocol.ts"
import type { FileEntry } from "../../../../client/src/files.ts"
import { useFileTarget } from "../../composables/useFileTarget.ts"
import { attachmentsFromFiles, createMachineFileAttachment, createPastedTextAttachment, hasSubmittableText, shouldFoldPastedText, type ComposerAttachment } from "../../services/composer-attachments.ts"
import { fileSize } from "../../services/file-format.ts"
import { commandDraft, type ComposerMention } from "../../services/composer-mentions.ts"
import type { AgentConfiguration } from "../../../../client/src/agent-configuration.ts"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"
import type { SessionTarget } from "../../stores/fleet.ts"
import AgentConfigurationSelector from "./AgentConfigurationSelector.vue"
import AgentUsage from "./AgentUsage.vue"
import ComposerCompletions from "./ComposerCompletions.vue"
import { useComposerCompletions } from "./useComposerCompletions.ts"
import type { AgentUsage as AgentUsageUpdate } from "../../services/agent-usage.ts"
const configurationLoading = ref(false)
const filePickerOpen = ref(false)
const props = defineProps<{
  location: SessionTarget | null
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
const attachments = defineModel<ComposerAttachment[]>("attachments", { default: () => [] })
const mentions = defineModel<ComposerMention[]>("mentions", { default: () => [] })
/** The execution context a new Session will use; only offered with `showTarget`. */
const context = defineModel<AgentSessionContext>("context", { default: "worktree" })
/** The base branch for a new worktree Session; only offered when `showTarget` and `context === "worktree"`. */
const baseBranch = defineModel<string>("baseBranch")
const emit = defineEmits<{ submit: [delivery: "backlog" | "steer"]; cancel: [] }>()
const { t } = useI18n()
const agents = useAgentSessionsStore()
const textarea = useTemplateRef<HTMLTextAreaElement>("textarea")
const configurationSelector = useTemplateRef<InstanceType<typeof AgentConfigurationSelector>>("configurationSelector")
const configuration = ref<AgentConfiguration | null>(null)
const completionId = useId()
const completion = reactive(useComposerCompletions({
  draft, mentions, textarea, location: () => props.location,
  disabled: () => !!(props.disabled || props.submitting), configuration,
  discover: () => configurationSelector.value?.discover?.() ?? Promise.resolve(),
}))
const fileInput = useTemplateRef<HTMLInputElement>("fileInput")
const dropZoneRef = useTemplateRef<HTMLElement>("dropZoneRef")
useTextareaAutosize({ element: textarea, input: draft })
const fileTarget = useFileTarget(() => props.location?.machine.id)
const filesApi = computed(() => client.files)
const initialPickerPath = computed(() => props.location?.worktree?.directories[0]?.path ?? props.location?.workspace?.directories[0]?.path)
const empty = computed(() => !hasSubmittableText(draft.value, attachments.value))
const commandInput = computed(() => commandDraft(draft.value) || mentions.value.some(mention => mention.reference.kind === "skill" && mention.reference.invocation.startsWith("/")))
const placeholder = computed(() => t(props.activeTurn ? "agent.backlogHint" : "composer.placeholder"))
const checkout = computed(() => props.location?.worktree?.directories.find(directory => directory.git)?.git ?? undefined)
const changes = computed(() => (checkout.value?.changes ?? []).reduce((total, change) => ({ additions: total.additions + change.additions, deletions: total.deletions + change.deletions }), { additions: 0, deletions: 0 }))
const availableBranches = ref<string[]>([])
let branchProbeGeneration = 0
watch(() => [props.showTarget, props.location?.workspace?.id, props.location?.machine.online] as const, async ([showTarget, workspaceId, online], previous) => {
  const token = ++branchProbeGeneration
  if (workspaceId !== previous?.[1]) {
    availableBranches.value = []
    baseBranch.value = undefined
  }
  if (!showTarget || !workspaceId || !online) {
    if (!showTarget || !workspaceId) {
      availableBranches.value = []
      baseBranch.value = undefined
    }
    return
  }
  try {
    const snapshot = await agents.gitBranches(workspaceId)
    if (token !== branchProbeGeneration) return
    const branches = snapshot?.branches ?? []
    availableBranches.value = branches
    if (!branches.length) {
      baseBranch.value = undefined
    } else if (!baseBranch.value || !branches.includes(baseBranch.value)) {
      baseBranch.value = (snapshot?.currentBranch && branches.includes(snapshot.currentBranch)) ? snapshot.currentBranch : branches[0]
    }
  } catch {
    if (token !== branchProbeGeneration) return
    availableBranches.value = []
    baseBranch.value = undefined
  }
}, { immediate: true })
const { isOverDropZone } = useDropZone(dropZoneRef, {
  onDrop(files) {
    if (files?.length && !props.disabled && !props.submitting) void addFiles(files)
  },
})
async function addFiles(files: Iterable<File>): Promise<void> {
  const added = await attachmentsFromFiles(files)
  if (added.length) attachments.value = [...attachments.value, ...added]
}
async function onFilesPicked(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  if (input.files?.length) await addFiles(Array.from(input.files))
  input.value = ""
}
function onMachineFilesSelected(entries: FileEntry[]): void {
  filePickerOpen.value = false
  if (!entries.length) return
  const added = entries.map(entry => createMachineFileAttachment(entry))
  attachments.value = [...attachments.value, ...added]
}
function removeAttachment(id: string): void {
  attachments.value = attachments.value.filter(item => item.id !== id)
}
function attachmentLabel(item: ComposerAttachment): string {
  return item.kind === "pasted_text" ? t("composer.pastedText") : item.name
}
function onPaste(event: ClipboardEvent): void {
  if (props.disabled || props.submitting) return
  const files = event.clipboardData?.files
  if (files && files.length > 0) {
    event.preventDefault()
    void addFiles(Array.from(files))
    return
  }
  const text = event.clipboardData?.getData("text/plain")
  if (text && shouldFoldPastedText(text)) {
    event.preventDefault()
    attachments.value = [...attachments.value, createPastedTextAttachment(text)]
  }
}
function submit(delivery: "backlog" | "steer"): void {
  if (props.disabled || props.submitting || configurationLoading.value || !props.location || empty.value) return
  emit("submit", commandInput.value ? "backlog" : delivery)
}
function keydown(event: KeyboardEvent): void {
  if (completion.keydown(event)) return
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit("backlog") }
}
</script>

<template>
  <div class="mx-auto flex w-full max-w-3xl shrink-0 flex-col gap-2 px-6 pb-5">
    <div v-if="location" class="flex h-9 min-w-0 items-center gap-3 rounded-xl border border-ui-border bg-ui-surface px-3 text-[13px] text-ui-text-muted" role="group" :aria-label="t('composer.context')">
      <span class="inline-flex min-w-0 items-center gap-1.5" data-composer-context><Monitor :size="15" :stroke-width="1.75" class="shrink-0" aria-hidden="true" /><span class="truncate">{{ location.machine.name }}</span><span v-if="showTarget && location.machine.local" class="ui-badge">{{ t("machine.local") }}</span></span>
      <template v-if="location.workspace">
        <span class="h-4 w-px shrink-0 bg-ui-border" aria-hidden="true" />
        <span class="inline-flex min-w-0 items-center gap-1.5" data-composer-context><Folder :size="15" :stroke-width="1.75" class="shrink-0" aria-hidden="true" /><span class="truncate">{{ location.workspace.name }}</span></span>
      </template>
      <template v-if="showTarget && location.workspace">
        <span class="h-4 w-px shrink-0 bg-ui-border" aria-hidden="true" />
        <label class="inline-flex min-w-0 cursor-pointer select-none items-center gap-1.5 text-ui-text" :title="t(`composer.contextHint.${context}`)" data-composer-context>
          <UiCheckbox :model-value="context === 'worktree'" :aria-label="t('composer.contextOption.worktree')" @update:model-value="context = $event ? 'worktree' : 'directory'" />
          <span class="truncate">{{ t("composer.contextOption.worktree") }}</span>
        </label>
        <template v-if="context === 'worktree' && availableBranches.length && baseBranch">
          <span class="h-4 w-px shrink-0 bg-ui-border" aria-hidden="true" />
          <DropdownMenuRoot :modal="false">
            <DropdownMenuTrigger class="inline-flex h-7 min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-ui-text hover:bg-ui-hover" :aria-label="t('composer.baseBranchChoice', { branch: baseBranch })" data-composer-branch>
              <GitBranch :size="15" :stroke-width="1.75" class="shrink-0 text-ui-text-muted" aria-hidden="true" /><span class="truncate">{{ baseBranch }}</span><ChevronDown :size="14" :stroke-width="2" class="shrink-0 text-ui-text-muted" aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuPortal>
            <DropdownMenuContent side="top" align="start" :side-offset="4" :collision-padding="8" :aria-label="t('composer.baseBranch')" class="ui-menu z-50 flex max-h-64 w-64 flex-col overflow-y-auto" loop>
              <DropdownMenuRadioGroup v-model="baseBranch">
              <DropdownMenuRadioItem v-for="branch in availableBranches" :key="branch" as="button" type="button" :value="branch" class="ui-menu-item">
                <GitBranch :size="15" :stroke-width="1.75" class="shrink-0 text-ui-text-muted" aria-hidden="true" />
                <span class="min-w-0 flex-1 truncate text-[13px] text-ui-text">{{ branch }}</span>
                <Check v-if="branch === baseBranch" :size="15" :stroke-width="2" class="shrink-0" aria-hidden="true" />
              </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
            </DropdownMenuPortal>
          </DropdownMenuRoot>
        </template>
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
    <div ref="dropZoneRef" class="relative rounded-2xl border bg-ui-surface shadow-ui-card transition-colors focus-within:border-ui-accent/60" :class="isOverDropZone ? 'border-ui-accent bg-ui-accent/5' : 'border-ui-border'">
      <ComposerCompletions v-if="completion.trigger" :id="completionId" :candidates="completion.candidates" :selected="completion.selected" :loading="completion.loading" :error="completion.error" :truncated="completion.truncated" :kind="completion.trigger.kind" @select="completion.accept" @highlight="completion.selected = $event" />
      <span v-if="showTarget && submitting" class="composer-creation-beam" aria-hidden="true" />
      <input ref="fileInput" type="file" multiple class="sr-only" data-composer-file-input @change="onFilesPicked" />
      <ul v-if="attachments.length" class="m-0 flex list-none flex-wrap gap-2 px-3 pt-3 pb-0" :aria-label="t('composer.attachments')" data-composer-attachments>
        <li v-for="item in attachments" :key="item.id" class="inline-flex max-w-full items-center gap-2 rounded-lg border border-ui-border bg-ui-canvas px-2.5 py-1.5 text-xs" :data-attachment-kind="item.kind">
          <img v-if="item.kind === 'image'" :src="`data:${item.mimeType};base64,${item.data}`" :alt="item.name" class="h-6 w-6 shrink-0 rounded object-cover" />
          <FileText v-else-if="item.kind === 'pasted_text'" :size="14" class="shrink-0 text-ui-text-muted" aria-hidden="true" />
          <File v-else :size="14" class="shrink-0 text-ui-text-muted" aria-hidden="true" />
          <span class="min-w-0 truncate font-medium text-ui-text" :title="item.kind === 'machine_file' ? item.path : attachmentLabel(item)">{{ attachmentLabel(item) }}</span>
          <span v-if="item.kind === 'pasted_text'" class="shrink-0 rounded bg-ui-badge px-1.5 py-0.5 text-[11px] text-ui-text-muted">{{ t("composer.pastedTextLines", item.lines) }}</span>
          <span v-else-if="item.size !== undefined" class="shrink-0 text-[11px] tabular-nums text-ui-text-muted">{{ fileSize(item.size) }}</span>
          <button type="button" class="inline-flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded text-ui-text-muted hover:bg-ui-hover hover:text-ui-text" :aria-label="t('composer.removeAttachment', { name: attachmentLabel(item) })" :disabled="disabled || submitting" @click="removeAttachment(item.id)">
            <X :size="12" aria-hidden="true" />
          </button>
        </li>
      </ul>
      <ul v-if="mentions.length" class="m-0 flex list-none flex-wrap gap-2 px-3 pt-3 pb-0" :aria-label="t('composer.completions.references')" data-composer-mentions>
        <li v-for="mention in mentions" :key="mention.id" class="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-ui-border bg-ui-canvas px-2.5 py-1.5 text-xs" :data-mention-kind="mention.reference.kind">
          <component :is="mention.reference.kind === 'file' ? File : mention.reference.kind === 'session' ? MessageSquare : Sparkles" :size="14" class="shrink-0 text-ui-text-muted" aria-hidden="true" />
          <span class="truncate text-ui-text" :title="mention.token">{{ mention.token }}</span>
          <button type="button" class="inline-flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded text-ui-text-muted hover:bg-ui-hover hover:text-ui-text" :aria-label="t('composer.completions.remove', { name: mention.token })" :disabled="disabled || submitting" @click="completion.remove(mention.id)"><X :size="12" aria-hidden="true" /></button>
        </li>
      </ul>
      <textarea ref="textarea" :value="draft" rows="2" role="combobox" aria-autocomplete="list" :aria-expanded="!!completion.trigger" :aria-controls="completion.trigger ? completionId : undefined" :aria-activedescendant="completion.trigger && completion.candidates.length ? `${completionId}-${completion.selected}` : undefined" class="block max-h-60 min-h-14 w-full resize-none bg-transparent px-4 pt-3 text-[15px] leading-6 outline-none select-text placeholder:text-ui-text-faint" :aria-label="t('composer.label')" :placeholder="placeholder" @input="completion.input" @focus="completion.focused = true; completion.cursor()" @blur="completion.focused = false" @click="completion.cursor" @select="completion.cursor" @keyup="completion.cursor" @compositionstart="completion.composing = true" @compositionend="completion.composing = false; completion.input($event)" @keydown="keydown" @paste="onPaste" />
      <div class="flex items-center gap-2 px-3 pb-2.5">
        <DropdownMenuRoot v-if="location" :modal="false">
          <DropdownMenuTrigger class="ui-button-ghost h-7 w-7 shrink-0 rounded-lg p-0 text-ui-text-muted hover:bg-ui-hover hover:text-ui-text" :aria-label="t('composer.attach')" :title="t('composer.attach')" :disabled="disabled || submitting" data-composer-attach>
            <Plus :size="16" :stroke-width="2" aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuPortal>
            <DropdownMenuContent side="top" align="start" :side-offset="4" :collision-padding="8" :aria-label="t('composer.attach')" class="ui-menu z-50 flex min-w-52 flex-col" loop>
              <DropdownMenuItem as="button" type="button" class="ui-menu-item" data-attach-local @select="fileInput?.click()">
                <Upload :size="15" :stroke-width="1.75" class="shrink-0 text-ui-text-muted" aria-hidden="true" />
                <span class="truncate text-[13px] text-ui-text">{{ t("composer.uploadLocalFiles") }}</span>
              </DropdownMenuItem>
              <DropdownMenuItem as="button" type="button" class="ui-menu-item" :disabled="!fileTarget || !filesApi" data-attach-machine @select="filePickerOpen = true">
                <HardDrive :size="15" :stroke-width="1.75" class="shrink-0 text-ui-text-muted" aria-hidden="true" />
                <span class="truncate text-[13px] text-ui-text">{{ t("composer.chooseMachineFiles") }}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenuPortal>
        </DropdownMenuRoot>
        <AgentConfigurationSelector v-if="location" ref="configurationSelector" :workspace-id="location.workspace?.id" :session-id="location.session?.id" :disabled="disabled || submitting || activeTurn" @loading="configurationLoading = $event" @configuration="configuration = $event" />
        <div class="ml-auto flex shrink-0 items-center gap-2">
          <AgentUsage v-if="usage" :key="location?.session?.id" :usage="usage" />
          <UiButton variant="ghost" size="sm" v-if="canSteer && !empty && !commandInput" type="button" class="cursor-pointer hover:bg-ui-hover hover:text-ui-text disabled:cursor-default disabled:opacity-50" :disabled="disabled || submitting || configurationLoading" @click="submit('steer')"><CornerDownRight :size="14" :stroke-width="1.75" aria-hidden="true" />{{ t('agent.steer') }}</UiButton>
          <UiButton v-if="canCancel && empty" variant="primary" size="icon" class="h-8 w-8 rounded-full" :title="t('agent.cancelTurn')" :aria-label="t('agent.cancelTurn')" @click="emit('cancel')"><Square :size="12" :stroke-width="0" fill="currentColor" aria-hidden="true" /></UiButton>
          <UiButton v-else variant="primary" size="icon" class="h-8 w-8 rounded-full" :title="t(activeTurn ? 'agent.addToBacklog' : 'composer.send')" :aria-label="t(activeTurn ? 'agent.addToBacklog' : 'composer.send')" :disabled="disabled || submitting || configurationLoading || !location || empty" @click="submit('backlog')"><ArrowUp :size="17" :stroke-width="2" aria-hidden="true" /></UiButton>
        </div>
      </div>
    </div>
    <FilePickerDialog
      v-if="filePickerOpen && location && fileTarget && filesApi"
      :api="filesApi"
      :target="fileTarget"
      :initial-path="initialPickerPath"
      :machine-name="location.machine.name"
      @select="onMachineFilesSelected"
      @cancel="filePickerOpen = false"
    />
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
