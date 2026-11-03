<script setup lang="ts">
import { X } from "@lucide/vue"
import { storeToRefs } from "pinia"
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from "reka-ui"
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { useRouteWorktree } from "../../composables/useRouteWorktree.ts"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"
import { activeDetailsTab, closeMermaidSidebarTab, mermaidSidebarTabs, useLayoutStore } from "../../stores/layout.ts"
import { closePreviewSidebarTab, previewSidebarTabs } from "../../stores/previews.ts"
import MermaidViewer from "../session/MermaidViewer.vue"
import PreviewViewer from "../session/PreviewViewer.vue"
import GitChanges from "./GitChanges.vue"
import IconButton from "../common/IconButton.vue"

defineProps<{ windowed?: boolean; standalone?: boolean }>()
const { t } = useI18n()
const worktree = useRouteWorktree()
const agents = useAgentSessionsStore()
const layout = useLayoutStore()
const { compact } = storeToRefs(layout)

const unavailable = computed(() => {
  const session = worktree.value && agents.sessions[worktree.value.session.id]
  const archiveState = session?.archiveState ?? worktree.value?.session.archiveState
  if (archiveState && archiveState !== "active") return t(archiveState === "archived" ? "agent.archived" : "agent.archiving")
  if (session && session.lifecycle !== "ready") return t(`agent.lifecycle.${session.lifecycle}`)
  return null
})
const currentTab = computed(() =>
  [...mermaidSidebarTabs.value, ...previewSidebarTabs.value].some(tab => tab.id === activeDetailsTab.value) ? activeDetailsTab.value : "changes",
)
function tabTitle(index: number): string {
  const tab = previewSidebarTabs.value[index]
  const kind = tab?.kind ?? "mermaid"
  const base = tab?.title
    || (kind === "mermaid" ? t("mermaid.title") : kind === "image" ? t("agent.image") : t("agent.contentType", { type: kind }))
  return previewSidebarTabs.value.length > 1 ? `${base} ${index + 1}` : base
}
</script>

<template>
  <aside
    :aria-label="t('panel.changes')"
    class="relative flex h-full w-full shrink-0 flex-col bg-ui-canvas"
    :class="!windowed && 'border-l border-ui-border'"
  >
    <TabsRoot v-if="!standalone && (mermaidSidebarTabs.length || previewSidebarTabs.length)" :model-value="currentTab" class="flex min-h-0 flex-1 flex-col" @update:model-value="activeDetailsTab = String($event)">
      <div class="titlebar-overlay-inset app-drag flex h-12 shrink-0 items-center border-b border-ui-border px-2">
        <TabsList :aria-label="t('panel.changes')" class="app-no-drag flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto" loop>
          <TabsTrigger value="changes" class="ui-tab h-full px-2.5 text-[13px] font-medium" :class="currentTab === 'changes' && 'ui-tab-active'">{{ t('panel.changes') }}</TabsTrigger>
          <div v-for="(tab, index) in mermaidSidebarTabs" :key="tab.id" role="presentation" class="ui-tab group h-full cursor-default pr-1" :class="currentTab === tab.id && 'ui-tab-active'">
            <TabsTrigger :value="tab.id" :data-mermaid-tab="tab.id" class="flex h-full cursor-pointer items-center pl-2.5 pr-1 text-[13px] font-medium">{{ mermaidSidebarTabs.length > 1 ? `${t('mermaid.title')} ${index + 1}` : t('mermaid.title') }}</TabsTrigger>
            <button type="button" :aria-label="t('mermaid.closeTab', { title: t('mermaid.title') })" :title="t('mermaid.closeTab', { title: t('mermaid.title') })" data-mermaid-tab-close class="inline-flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-ui-text-muted ui-motion hover:bg-ui-hover hover:text-ui-text active:scale-90" @click.stop="closeMermaidSidebarTab(tab.id)"><X :size="13" aria-hidden="true" /></button>
          </div>
          <div v-for="(tab, index) in previewSidebarTabs" :key="tab.id" role="presentation" class="ui-tab group h-full cursor-default pr-1" :class="currentTab === tab.id && 'ui-tab-active'">
            <TabsTrigger :value="tab.id" :data-preview-tab="tab.id" class="flex h-full cursor-pointer items-center pl-2.5 pr-1 text-[13px] font-medium">{{ tabTitle(index) }}</TabsTrigger>
            <button type="button" :aria-label="t('mermaid.closeTab', { title: tabTitle(index) })" :title="t('mermaid.closeTab', { title: tabTitle(index) })" data-preview-tab-close class="inline-flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-ui-text-muted ui-motion hover:bg-ui-hover hover:text-ui-text active:scale-90" @click.stop="closePreviewSidebarTab(tab.id)"><X :size="13" aria-hidden="true" /></button>
          </div>
        </TabsList>
        <IconButton v-if="compact" :icon="X" :label="t('toolbar.hidePanel')" @click="layout.toggleDetails()" />
      </div>
      <TabsContent value="changes" class="flex min-h-0 flex-1 flex-col overflow-hidden">
        <GitChanges v-if="worktree && !unavailable" :key="worktree.session.id" class="min-h-0 min-w-0 flex-1" :session-id="worktree.session.id" :enabled="worktree.machine.online" />
        <p v-else class="m-0 px-4 pt-3 text-[13px] text-ui-text-muted">{{ unavailable ?? t('panel.noWorktree') }}</p>
      </TabsContent>
      <TabsContent v-for="tab in mermaidSidebarTabs" :key="tab.id" :value="tab.id" data-mermaid-sidebar-view class="flex min-h-0 flex-1 flex-col p-2">
        <MermaidViewer :code="tab.code" :source="tab.source" mode="sidebar" class="min-h-0 flex-1" />
      </TabsContent>
      <TabsContent v-for="tab in previewSidebarTabs" :key="tab.id" :value="tab.id" data-preview-sidebar-view class="flex min-h-0 flex-1 flex-col p-2">
        <PreviewViewer
          :kind="tab.kind"
          :content="tab.content"
          :title="tab.title"
          :mime-type="tab.mimeType"
          :source="tab.source"
          mode="sidebar"
          class="min-h-0 flex-1"
        />
      </TabsContent>
    </TabsRoot>
    <template v-else>
      <div v-if="!windowed" class="titlebar-overlay-inset app-drag flex h-12 shrink-0 items-center pl-4">
        <h2 class="m-0 flex-1 text-[13px] font-medium">{{ t('panel.changes') }}</h2>
        <IconButton v-if="compact" :icon="X" :label="t('toolbar.hidePanel')" @click="layout.toggleDetails()" />
      </div>
      <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <GitChanges v-if="worktree && !unavailable" :key="worktree.session.id" class="min-h-0 min-w-0 flex-1" :session-id="worktree.session.id" :enabled="worktree.machine.online" />
        <p v-else class="m-0 px-4 pt-1 text-[13px] text-ui-text-muted">{{ unavailable ?? t('panel.noWorktree') }}</p>
      </div>
    </template>
  </aside>
</template>
