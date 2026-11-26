<script setup lang="ts">
import { AppWindow, Download, ExternalLink, Eye, FileCode, FolderOpen, LocateFixed, Maximize2, PanelRight } from "@lucide/vue"
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import { revealResourceLabel } from "../../services/agent-resources.ts"
import type { PreviewMode, PreviewToolbarAction, PreviewView } from "../../services/preview.ts"
import UiButton from "../common/UiButton.vue"

const props = withDefaults(defineProps<{
  mode: PreviewMode
  title?: string
  titleTooltip?: string
  actions?: PreviewToolbarAction[]
  views?: readonly PreviewView[]
  activeView?: PreviewView
  canFocus?: boolean
  canDownload?: boolean
  canOpen?: boolean
  canReveal?: boolean
  canShowInRightTab?: boolean
  canShowInNewWindow?: boolean
  canLocateMessage?: boolean
  rightTabLabel?: string
}>(), {
  actions: () => [],
  views: () => [],
})

const emit = defineEmits<{
  selectView: [view: PreviewView]
  focus: []
  download: []
  open: []
  reveal: []
  showInRightTab: []
  showInNewWindow: []
  locateMessage: []
}>()

const { t } = useI18n()
const client = usePlatformClient()
const showViewSwitch = computed(() => props.views.length > 1)
const showFocus = computed(() => Boolean(props.canFocus && props.mode === "inline"))
const showLocate = computed(() => Boolean(props.canLocateMessage && props.mode !== "inline" && props.mode !== "dialog"))
const showRightTab = computed(() => Boolean(props.canShowInRightTab && props.mode !== "tab" && props.mode !== "dialog"))
const showNewWindow = computed(() => Boolean(props.canShowInNewWindow && props.mode !== "window" && props.mode !== "dialog"))
const showDownload = computed(() => Boolean(!props.canOpen && !props.canReveal && props.canDownload && props.mode !== "dialog"))
const showReveal = computed(() => Boolean(props.canReveal && props.mode !== "dialog"))
const showOpen = computed(() => Boolean(props.canOpen && props.mode !== "dialog"))
const hasChromeActions = computed(() =>
  showFocus.value || showLocate.value || showRightTab.value || showNewWindow.value || showReveal.value || showOpen.value || showDownload.value,
)
const revealLabel = computed(() => revealResourceLabel(client.platform, t))
const viewLabel = (view: PreviewView) => t(view === "source" ? "files.viewSource" : "files.preview")
const viewActionId = (view: PreviewView) => view === "source" ? "source" : `preview-${view}`
</script>

<template>
  <header
    v-if="mode !== 'dialog' || actions.length || showViewSwitch"
    data-preview-toolbar
    class="flex shrink-0 items-center justify-between gap-2"
    :class="mode === 'window'
      ? ['app-drag titlebar-overlay-inset h-12 border-b border-ui-border pr-3', client.platform === 'darwin' ? 'pl-20' : 'pl-4']
      : mode === 'dialog'
        ? 'mb-2 justify-end'
        : 'min-h-9 border-b border-ui-border px-3 py-1'"
  >
    <h1 v-if="mode === 'window'" class="m-0 min-w-0 flex-1 truncate text-sm font-medium text-ui-text" :title="titleTooltip ?? title">{{ title }}</h1>
    <span v-else-if="mode !== 'dialog'" class="min-w-0 flex-1 truncate text-xs font-medium text-ui-text-muted" :title="titleTooltip ?? title">{{ title }}</span>

    <div role="toolbar" :aria-label="title || t('files.preview')" class="app-no-drag flex shrink-0 items-center gap-0.5">
      <UiButton
        v-for="action in actions"
        :key="action.id"
        variant="ghost"
        size="icon"
        :label="action.label"
        :aria-pressed="action.pressed !== undefined ? String(action.pressed) : undefined"
        :data-preview-action="action.id"
        :class="action.pressed && 'ui-nav-active'"
        @click="action.onClick"
      ><component :is="action.icon" :size="16" :stroke-width="1.75" aria-hidden="true" /></UiButton>

      <span v-if="actions.length && (showViewSwitch || hasChromeActions)" role="separator" aria-orientation="vertical" class="mx-1 h-3.5 border-l border-ui-border" />

      <div v-if="showViewSwitch" role="group" :aria-label="t('files.preview')" data-preview-view-switch class="ui-segmented shrink-0 p-0.5">
        <button
          v-for="view in views"
          :key="view"
          type="button"
          :aria-pressed="activeView === view ? 'true' : 'false'"
          :data-preview-action="viewActionId(view)"
          class="ui-segment inline-flex min-h-6 min-w-6 items-center gap-1 border-0 bg-transparent px-2 py-0.5 font-medium"
          :class="activeView === view && 'ui-segment-active'"
          @click="emit('selectView', view)"
        ><component :is="view === 'source' ? FileCode : Eye" :size="13" :stroke-width="1.75" aria-hidden="true" /><span>{{ viewLabel(view) }}</span></button>
      </div>

      <span v-if="showViewSwitch && hasChromeActions" role="separator" aria-orientation="vertical" class="mx-1 h-3.5 border-l border-ui-border" />

      <UiButton v-if="showFocus" variant="ghost" size="icon" :label="t('mermaid.focus')" data-preview-action="focus" @click="emit('focus')"><Maximize2 :size="16" :stroke-width="1.75" aria-hidden="true" /></UiButton>
      <UiButton v-if="showLocate" variant="ghost" size="icon" :label="t('mermaid.locateMessage')" data-preview-action="locate-message" @click="emit('locateMessage')"><LocateFixed :size="16" :stroke-width="1.75" aria-hidden="true" /></UiButton>
      <UiButton v-if="showRightTab" variant="ghost" size="icon" :label="rightTabLabel || t('mermaid.showInRightTab')" data-preview-action="show-in-right-tab" @click="emit('showInRightTab')"><PanelRight :size="16" :stroke-width="1.75" aria-hidden="true" /></UiButton>
      <UiButton v-if="showNewWindow" variant="ghost" size="icon" :label="t('mermaid.showInNewWindow')" data-preview-action="show-in-new-window" @click="emit('showInNewWindow')"><AppWindow :size="16" :stroke-width="1.75" aria-hidden="true" /></UiButton>
      <UiButton v-if="showReveal" variant="ghost" size="icon" :label="revealLabel" data-preview-action="reveal" @click="emit('reveal')"><FolderOpen :size="16" :stroke-width="1.75" aria-hidden="true" /></UiButton>
      <UiButton v-if="showOpen" variant="ghost" size="icon" :label="t('files.openResource')" data-preview-action="open" @click="emit('open')"><ExternalLink :size="16" :stroke-width="1.75" aria-hidden="true" /></UiButton>
      <UiButton v-if="showDownload" variant="ghost" size="icon" :label="t('files.downloadResource')" data-preview-action="download" @click="emit('download')"><Download :size="16" :stroke-width="1.75" aria-hidden="true" /></UiButton>
    </div>
  </header>
</template>
