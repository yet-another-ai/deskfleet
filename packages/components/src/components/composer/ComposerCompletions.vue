<script setup lang="ts">
import { File, LoaderCircle, MessageSquare, Slash, Sparkles } from "@lucide/vue"
import { computed, useTemplateRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { ComposerCandidate } from "./useComposerCompletions.ts"
const props = defineProps<{ id: string; candidates: ComposerCandidate[]; selected: number; loading: boolean; error?: string; truncated: boolean; kind: "reference" | "skill" | "command" }>()
const emit = defineEmits<{ select: [candidate: ComposerCandidate]; highlight: [index: number] }>()
const { t } = useI18n()
const root = useTemplateRef<HTMLElement>("root")
const kinds = ["file", "session", "skill", "command"] as const
const icons = { file: File, session: MessageSquare, skill: Sparkles, command: Slash }
const groups = computed(() => kinds.map(kind => ({ kind, candidates: props.candidates.map((candidate, index) => ({ candidate, index })).filter(item => item.candidate.kind === kind) })).filter(group => group.candidates.length))
watch(() => props.selected, () => root.value?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }), { flush: "post" })
</script>

<template>
  <div ref="root" class="absolute bottom-full left-0 z-50 mb-2 max-h-72 w-full overflow-y-auto rounded-xl border border-ui-border bg-ui-surface p-1.5 shadow-ui-card" data-composer-completions>
    <div :id="id" role="listbox" :aria-label="t('composer.completions.label')" :aria-busy="loading">
      <div v-for="group in groups" :key="group.kind" role="group" :aria-label="t(`composer.completions.${group.kind}`)">
        <p class="m-0 px-2 py-1 text-[11px] font-medium text-ui-text-muted">{{ t(`composer.completions.${group.kind}`) }}</p>
        <button v-for="{ candidate, index } in group.candidates" :id="`${id}-${index}`" :key="candidate.key" type="button" role="option" :aria-selected="selected === index" tabindex="-1" class="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-left text-[13px] hover:bg-ui-hover" :class="selected === index && 'bg-ui-hover'" :data-completion-kind="candidate.kind" @pointerdown.prevent @click="emit('select', candidate)" @pointermove="emit('highlight', index)">
          <component :is="icons[candidate.kind]" :size="15" class="shrink-0 text-ui-text-muted" aria-hidden="true" />
          <span class="min-w-0 flex-1"><span class="block truncate text-ui-text">{{ candidate.name }}</span><span v-if="candidate.description" class="block truncate text-xs text-ui-text-muted">{{ candidate.description }}</span></span>
        </button>
      </div>
    </div>
    <p v-if="loading" role="status" class="m-0 flex items-center gap-2 px-2 py-2 text-xs text-ui-text-muted"><LoaderCircle :size="13" class="animate-spin" aria-hidden="true" />{{ t('composer.completions.loading') }}</p>
    <p v-else-if="!candidates.length && !error" role="status" class="m-0 px-2 py-2 text-xs text-ui-text-muted">{{ t(kind === 'reference' ? 'composer.completions.empty' : kind === 'skill' ? 'composer.completions.noSkills' : 'composer.completions.noCommands') }}</p>
    <p v-if="error" role="alert" class="m-0 px-2 py-2 text-xs text-ui-danger">{{ error }}</p>
    <p v-if="truncated" class="m-0 px-2 py-1 text-xs text-ui-text-muted">{{ t('composer.completions.refine') }}</p>
    <p v-if="candidates.length" class="m-0 border-t border-ui-border px-2 pt-1.5 pb-1 text-[11px] text-ui-text-muted">{{ t('composer.completions.keyboard') }}</p>
  </div>
</template>
