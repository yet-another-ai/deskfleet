<script setup lang="ts">
import { Check, LoaderCircle, WandSparkles } from "@lucide/vue"
import { useConfirmDialog } from "@vueuse/core"
import { computed, onScopeDispose, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { AgentSessionContext } from "../../../../../apps/daemon/src/agent-protocol.ts"
import type { GitPreparationSnapshot } from "../../../../../apps/daemon/src/git-protocol.ts"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"
import type { SessionTarget } from "../../stores/fleet.ts"
import UiButton from "../common/UiButton.vue"
import UiDialog from "../common/UiDialog.vue"

const props = defineProps<{ location: SessionTarget; context: AgentSessionContext; disabled?: boolean }>()
const baseRevisions = defineModel<GitPreparationSnapshot["baseRevisions"]>("baseRevisions")
const branches = defineModel<string[]>("branches", { default: () => [] })
const emit = defineEmits<{ busy: [value: boolean] }>()
const agents = useAgentSessionsStore()
const { t } = useI18n()
const busy = ref(false)
const result = ref<GitPreparationSnapshot>()
const error = ref<string>()
const dialog = useConfirmDialog()
const { isRevealed, confirm, cancel } = dialog
const changedRepositories = computed(() => result.value?.repositories.filter(repository => repository.changes.length) ?? [])
const ready = computed(() => result.value?.status === "ready")
const label = computed(() => t(busy.value ? "composer.prepare.loading" : ready.value ? "composer.prepare.ready" : "composer.prepare.action"))
const hint = computed(() => ready.value ? result.value!.repositories.map(repository => `${repository.root} → ${repository.branch}`).join("\n")
  : t(`composer.prepare.hint.${props.context}`))
let generation = 0

function setBusy(value: boolean): void { busy.value = value; emit("busy", value) }
function reset(): void {
  generation++
  cancel()
  result.value = undefined
  error.value = undefined
  baseRevisions.value = undefined
  branches.value = []
  setBusy(false)
}
watch([
  () => props.location.machine.id,
  () => props.location.workspace?.id,
  () => props.location.machine.online,
  () => JSON.stringify(props.location.workspace?.directories.map(directory => directory.path)),
  () => props.context,
], reset)
onScopeDispose(reset)
defineExpose({ reset })

async function prepare(): Promise<void> {
  const workspaceId = props.location.workspace?.id
  if (!workspaceId || busy.value || props.disabled || !props.location.machine.online) return
  reset()
  const token = generation
  const context = props.context
  setBusy(true)
  try {
    let snapshot = await agents.prepareGit(workspaceId, context)
    if (token !== generation) return
    while (snapshot.status === "confirmation_required") {
      result.value = snapshot
      const decision = await dialog.reveal()
      if (decision.isCanceled || token !== generation) return
      snapshot = await agents.prepareGit(workspaceId, context, snapshot.confirmationToken)
      if (token !== generation) return
    }
    result.value = snapshot
    baseRevisions.value = context === "worktree" ? snapshot.baseRevisions : undefined
    branches.value = [...new Set(snapshot.repositories.map(repository => repository.branch))]
  } catch (reason) {
    if (token === generation) error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    if (token === generation) setBusy(false)
  }
}
</script>

<template>
  <button type="button" class="ml-auto inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-ui-text-muted transition-colors hover:bg-ui-hover hover:text-ui-text disabled:cursor-default disabled:opacity-50"
    :class="ready ? 'text-ui-success' : ''" :disabled="disabled || busy || !location.machine.online" :aria-busy="busy || undefined"
    :aria-label="label" :title="hint" data-prepare-session @click="prepare">
    <LoaderCircle v-if="busy" :size="15" class="animate-spin" aria-hidden="true" />
    <Check v-else-if="ready" :size="15" aria-hidden="true" />
    <WandSparkles v-else :size="15" :stroke-width="1.75" aria-hidden="true" />
    <span class="hidden sm:inline">{{ label }}</span>
  </button>
  <UiDialog v-if="error" :title="t('composer.prepare.failed')" class="w-[min(30rem,calc(100vw-2rem))] p-5" @close="error = undefined">
    <h2 class="m-0 text-base font-semibold">{{ t('composer.prepare.failed') }}</h2>
    <p role="alert" class="my-4 whitespace-pre-wrap break-words text-sm text-ui-danger">{{ error }}</p>
    <div class="flex justify-end"><UiButton @click="error = undefined">{{ t('files.close') }}</UiButton></div>
  </UiDialog>
  <UiDialog v-if="isRevealed" :title="t('composer.prepare.confirmTitle')" class="w-[min(34rem,calc(100vw-2rem))] p-5" @close="cancel()">
    <h2 class="m-0 text-base font-semibold">{{ t('composer.prepare.confirmTitle') }}</h2>
    <p class="mb-3 text-sm text-ui-text-muted">{{ t('composer.prepare.confirmDescription') }}</p>
    <div class="max-h-64 space-y-3 overflow-y-auto rounded-lg border border-ui-border bg-ui-canvas p-3">
      <div v-for="repository in changedRepositories" :key="repository.root">
        <p class="m-0 break-all text-xs font-medium text-ui-text">{{ repository.root }} → {{ repository.branch }}</p>
        <ul class="mb-0 mt-1 pl-4 text-xs text-ui-text-muted">
          <li v-for="path in repository.changes" :key="path" class="break-all font-mono">{{ path }}</li>
        </ul>
      </div>
    </div>
    <p class="my-3 text-xs text-ui-text-muted">{{ t('composer.prepare.sharedDirectory') }}</p>
    <div class="flex justify-end gap-2">
      <UiButton data-prepare-cancel @click="cancel()">{{ t('catalog.cancel') }}</UiButton>
      <UiButton variant="danger" data-prepare-confirm @click="confirm()">{{ t('composer.prepare.discard') }}</UiButton>
    </div>
  </UiDialog>
</template>
