<script setup lang="ts">
import { ArrowUp, Folder, FolderTree, Monitor } from "@lucide/vue"
import { useTextareaAutosize } from "@vueuse/core"
import { ref, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"
import type { WorktreeLocation } from "../../stores/fleet.ts"
import { useWorktreeLabel } from "../../composables/useWorktreeLabel.ts"
import AgentConfigurationSelector from "./AgentConfigurationSelector.vue"

defineProps<{
  location: WorktreeLocation | null
  /** Shows where a new session will start: its machine, workspace, worktree, and provider. */
  showTarget?: boolean
}>()

const { t } = useI18n()
const worktreeLabel = useWorktreeLabel()

const draft = ref("")
const textarea = useTemplateRef<HTMLTextAreaElement>("textarea")
useTextareaAutosize({ element: textarea, input: draft })

const placeholderTitle = (label: string) => t("common.placeholderControl", { label })
</script>

<template>
  <div class="mx-auto w-full max-w-3xl shrink-0 px-6 pb-5">
    <div class="mb-2 flex flex-wrap items-center gap-2">
      <template v-if="showTarget && location">
        <span class="ui-chip" :title="placeholderTitle(location.machine.name)">
          <Monitor :size="15" :stroke-width="1.75" aria-hidden="true" />
          <span class="font-medium">{{ location.machine.name }}</span>
          <span v-if="location.machine.local" class="ui-badge">{{ t("machine.local") }}</span>
        </span>
        <span class="ui-chip" :title="placeholderTitle(location.workspace.name)">
          <Folder :size="15" :stroke-width="1.75" aria-hidden="true" />
          {{ location.workspace.name }}
        </span>
        <span class="ui-chip" :title="placeholderTitle(worktreeLabel(location.worktree))">
          <FolderTree :size="15" :stroke-width="1.75" aria-hidden="true" />
          {{ worktreeLabel(location.worktree) }}
        </span>
      </template>
      <AgentConfigurationSelector :worktree-id="location?.worktree.id" />
    </div>

    <div
      class="rounded-2xl border border-ui-border bg-ui-surface shadow-ui-card focus-within:border-ui-text-faint"
    >
      <textarea
        ref="textarea"
        v-model="draft"
        rows="2"
        class="block max-h-60 min-h-12 w-full resize-none bg-transparent px-4 pt-3 text-sm leading-6 outline-none select-text placeholder:text-ui-text-faint"
        :aria-label="t('composer.label')"
        :placeholder="t('composer.placeholder')"
      />
      <div class="flex justify-end px-2 pb-2">
        <button
          type="button"
          class="inline-flex h-8 w-8 cursor-default items-center justify-center rounded-full bg-ui-action-disabled text-ui-action-text"
          :title="placeholderTitle(t('composer.send'))"
          :aria-label="placeholderTitle(t('composer.send'))"
          aria-disabled="true"
        >
          <ArrowUp :size="17" :stroke-width="2" aria-hidden="true" />
        </button>
      </div>
    </div>
  </div>
</template>
