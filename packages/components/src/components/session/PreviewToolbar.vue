<script setup lang="ts">
import { Download, Ellipsis, ExternalLink, LocateFixed, Maximize2, PanelRight } from "@lucide/vue"
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuTrigger } from "reka-ui"
import { ref } from "vue"
import { useI18n } from "vue-i18n"
import type { PreviewMode, PreviewToolbarAction } from "../../services/preview.ts"
import UiButton from "../common/UiButton.vue"

defineProps<{
  mode: PreviewMode
  actions: PreviewToolbarAction[]
  canDownload?: boolean
  rightTabLabel: string
}>()

const emit = defineEmits<{
  focus: []
  download: []
  showInRightTab: []
  showInNewWindow: []
  locateMessage: []
}>()

const { t } = useI18n()
const menuOpen = ref(false)

function select(action: () => void): void {
  menuOpen.value = false
  action()
}
</script>

<template>
  <div data-preview-toolbar class="app-no-drag absolute top-2 right-2 z-10 flex items-center gap-0.5 rounded-lg border border-ui-border bg-ui-canvas/90 p-0.5 shadow-ui-card backdrop-blur-xs">
    <UiButton
      v-for="action in actions"
      :key="action.id"
      variant="ghost"
      size="icon"
      :label="action.label"
      :data-preview-action="action.id"
      @click="action.onClick"
    ><component :is="action.icon" :size="16" :stroke-width="1.75" aria-hidden="true" /></UiButton>
    <UiButton v-if="mode === 'inline'" variant="ghost" size="icon" :label="t('mermaid.focus')" data-preview-action="focus" @click="emit('focus')"><Maximize2 :size="16" :stroke-width="1.75" aria-hidden="true" /></UiButton>
    <DropdownMenuRoot v-model:open="menuOpen" :modal="false">
      <DropdownMenuTrigger :as="UiButton" variant="ghost" size="icon" :label="t('mermaid.more')" data-preview-action="more"><Ellipsis :size="16" :stroke-width="1.75" aria-hidden="true" /></DropdownMenuTrigger>
      <DropdownMenuPortal>
        <DropdownMenuContent align="end" :side-offset="4" :collision-padding="8" :aria-label="t('mermaid.more')" class="ui-menu z-50 flex w-44 flex-col" loop>
          <DropdownMenuItem v-if="canDownload" as="button" type="button" class="ui-menu-item" data-preview-action="download" @select="select(() => emit('download'))">
            <Download :size="14" aria-hidden="true" />{{ t('files.downloadResource') }}
          </DropdownMenuItem>
          <DropdownMenuItem v-if="mode !== 'tab'" as="button" type="button" class="ui-menu-item" data-preview-action="show-in-right-tab" @select="select(() => emit('showInRightTab'))">
            <PanelRight :size="14" aria-hidden="true" />{{ rightTabLabel }}
          </DropdownMenuItem>
          <DropdownMenuItem v-if="mode !== 'window'" as="button" type="button" class="ui-menu-item" data-preview-action="show-in-new-window" @select="select(() => emit('showInNewWindow'))">
            <ExternalLink :size="14" aria-hidden="true" />{{ t('mermaid.showInNewWindow') }}
          </DropdownMenuItem>
          <DropdownMenuItem v-if="mode !== 'inline'" as="button" type="button" class="ui-menu-item" data-preview-action="locate-message" @select="select(() => emit('locateMessage'))">
            <LocateFixed :size="14" aria-hidden="true" />{{ t('mermaid.locateMessage') }}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenuPortal>
    </DropdownMenuRoot>
  </div>
</template>
