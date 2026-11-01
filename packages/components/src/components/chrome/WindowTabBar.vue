<script setup lang="ts">
import "dockview-vue/dist/styles/dockview.css"
import { Plus, SquareTerminal } from "@lucide/vue"
import {
  DockviewVue,
  type DockviewGroupPanel,
  type DockviewReadyEvent,
  type IDockviewPanelHeaderProps,
} from "dockview-vue"
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from "reka-ui"
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { usePlatformClient } from "../../composables/usePlatformClient.ts"
import { useLayoutStore } from "../../stores/layout.ts"
import IconButton from "../common/IconButton.vue"
import WindowTab from "./WindowTab.vue"
import WindowToolbar from "./WindowToolbar.vue"
import { windowHeaderActionsId } from "./windowHeaderActions.ts"

type WorkspaceWindowId = "changes" | "terminal"

const props = defineProps<{
  detailsOpen: boolean
  chatTitle: string
  chatTooltip?: string
  topLeftGroupId?: string
}>()
const emit = defineEmits<{
  ready: [event: DockviewReadyEvent]
  "close-tab": [params: IDockviewPanelHeaderProps]
  "open-window": [id: WorkspaceWindowId, group: DockviewGroupPanel]
}>()
const { t } = useI18n()
const platform = usePlatformClient().platform
const layout = useLayoutStore()
const toolbarNeedsTrafficLightInset = computed(() => platform === "darwin" && !layout.sidebarOpen)

function tabPresentation(params: IDockviewPanelHeaderProps): { title: string; tooltip: string; closable: boolean } {
  if (params.api.id === "chat") {
    return {
      title: props.chatTitle,
      tooltip: props.chatTooltip ?? props.chatTitle,
      closable: false,
    }
  }

  return {
    title: params.api.title ?? params.api.id,
    tooltip: params.api.title ?? props.chatTitle,
    closable: true,
  }
}
</script>

<template>
  <section class="deskfleet-windows min-h-0 min-w-0 flex-1" :aria-label="t('toolbar.windows')">
    <DockviewVue
      class="dockview-theme-light h-full w-full"
      :get-tab-context-menu-items="() => []"
      @ready="emit('ready', $event)"
    >
      <template #panel-chat><slot name="chat" /></template>
      <template #panel-changes><slot name="changes" /></template>
      <template #panel-terminal="params"><slot name="terminal" v-bind="params" /></template>
      <template #defaultTab="params">
        <WindowTab
          :tab-id="params.api.id"
          v-bind="tabPresentation(params)"
          :close-label="t('toolbar.closeWindow', { title: params.api.title })"
          @close="emit('close-tab', params)"
        />
      </template>
      <template #prefixHeaderActions="{ group }">
        <div
          v-if="group.id === topLeftGroupId"
          class="app-no-drag ml-1 flex h-full items-center pr-[3px]"
          :class="{ 'pl-20': toolbarNeedsTrafficLightInset }"
          :data-window-toolbar-group="group.id"
        >
          <WindowToolbar :history="false" />
        </div>
      </template>
      <template #leftHeaderActions="{ group }">
        <DropdownMenuRoot :modal="false">
          <DropdownMenuTrigger :as="IconButton" :icon="Plus" :label="t('toolbar.addWindow')" class="app-no-drag mx-[3px]" />
          <DropdownMenuPortal>
            <DropdownMenuContent align="start" :side-offset="4" :collision-padding="8" :aria-label="t('toolbar.addWindow')" class="app-no-drag ui-menu z-50 flex w-44 flex-col" loop>
              <DropdownMenuItem as="button" type="button" data-window-type="changes" class="ui-menu-item" :disabled="detailsOpen" @select="emit('open-window', 'changes', group)">
                <span class="text-xs font-semibold" aria-hidden="true">±</span>{{ t("panel.changes") }}
              </DropdownMenuItem>
              <DropdownMenuItem as="button" type="button" data-window-type="terminal" class="ui-menu-item" @select="emit('open-window', 'terminal', group)">
                <SquareTerminal :size="14" aria-hidden="true" />{{ t("terminal.new") }}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenuPortal>
        </DropdownMenuRoot>
      </template>
      <template #rightHeaderActions="{ group }">
        <div :id="windowHeaderActionsId(group.id)" class="app-no-drag mr-[6px] flex h-full items-center gap-[6px]" data-window-header-actions :data-window-header-actions-group="group.id" />
      </template>
    </DockviewVue>
  </section>
</template>

<style scoped>
.deskfleet-windows :deep(.dockview-theme-light),
.deskfleet-windows :deep(.dockview-theme-abyss) {
  color-scheme: normal;
  --dv-group-view-background-color: var(--ui-color-canvas);
  --dv-tabs-and-actions-container-background-color: var(--ui-color-canvas);
  --dv-activegroup-visiblepanel-tab-background-color: color-mix(in srgb, var(--ui-color-accent) 12%, transparent);
  --dv-activegroup-hiddenpanel-tab-background-color: transparent;
  --dv-inactivegroup-visiblepanel-tab-background-color: color-mix(in srgb, var(--ui-color-accent) 12%, transparent);
  --dv-inactivegroup-hiddenpanel-tab-background-color: transparent;
  --dv-activegroup-visiblepanel-tab-color: var(--ui-color-accent);
  --dv-activegroup-hiddenpanel-tab-color: var(--ui-color-text);
  --dv-inactivegroup-visiblepanel-tab-color: var(--ui-color-accent);
  --dv-inactivegroup-hiddenpanel-tab-color: var(--ui-color-text);
  --dv-tab-divider-color: var(--ui-color-border);
  --dv-separator-border: var(--ui-color-border);
  --dv-icon-hover-background-color: var(--ui-color-hover);
  --dv-sash-color: transparent;
  --dv-active-sash-color: var(--ui-color-focus);
  --dv-drag-over-background-color: color-mix(in srgb, var(--ui-color-accent) 18%, transparent);
  --dv-drag-over-border: 1px solid var(--ui-color-accent);
  --dv-drag-over-border-color: var(--ui-color-accent);
  --dv-edge-dock-indicator-color: var(--ui-color-accent);
  --dv-tabs-and-actions-container-height: 48px;
  --dv-tabs-and-actions-container-font-size: 13px;
  --dv-tab-font-size: 13px;
  --dv-tab-margin: 6px 3px;
  --dv-floating-border: 1px solid var(--ui-color-border-strong);
  --dv-floating-box-shadow: var(--ui-shadow-dialog);
}
.deskfleet-windows :deep(.dv-tabs-and-actions-container) {
  padding-left: 2px;
  border-bottom: 1px solid var(--ui-color-border);
}
.deskfleet-windows :deep(.dv-tab) {
  height: 36px;
  cursor: pointer;
  padding: 0;
  border-radius: 0.5rem;
  transition: background-color 150ms ease, color 150ms ease;
}
.deskfleet-windows :deep(.dv-tab::before) { display: none; }
.deskfleet-windows :deep(.dv-active-tab:hover) { background: color-mix(in srgb, var(--ui-color-accent) 20%, transparent); }
.deskfleet-windows :deep(.dv-inactive-tab:hover) { background: var(--ui-color-hover); }
.deskfleet-windows :deep(.window-tab-close) {
  opacity: 0;
  pointer-events: none;
  transition: opacity 120ms ease-out;
}
.deskfleet-windows :deep(.dv-tab:hover .window-tab-close),
.deskfleet-windows :deep(.dv-tab:focus-within .window-tab-close) {
  opacity: 1;
  pointer-events: auto;
}
.deskfleet-windows :deep(.dv-pre-actions-container > .dv-vue-part),
.deskfleet-windows :deep(.dv-left-actions-container > .dv-vue-part),
.deskfleet-windows :deep(.dv-right-actions-container > .dv-vue-part) {
  display: flex;
  align-items: center;
}
.deskfleet-windows :deep(.dv-sash) { transition: background-color 120ms ease-out; }
.deskfleet-windows :deep(.dv-sash:hover) { background: color-mix(in srgb, var(--ui-color-focus) 45%, transparent); }
</style>
