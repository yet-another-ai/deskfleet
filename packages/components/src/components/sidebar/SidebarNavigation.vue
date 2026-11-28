<script setup lang="ts">
import { CalendarClock, MessagesSquare, MonitorPlay, Search } from "@lucide/vue"
import { vSpring } from "../../directives/spring.ts"
import { computed, useTemplateRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import { useRoute } from "vue-router"
import { useSidebarPanel, type SidebarPanel } from "../../composables/useSidebarPanel.ts"
import UiTooltip from "../common/UiTooltip.vue"

const { t } = useI18n()
const route = useRoute()
const sidebarPanel = useSidebarPanel()
const tablist = useTemplateRef<HTMLElement>("tablist")

const sections: readonly { id: SidebarPanel; label: string; icon: typeof MessagesSquare }[] = [
  { id: "conversations", label: "nav.conversations", icon: MessagesSquare },
  { id: "schedules", label: "schedules.title", icon: CalendarClock },
  { id: "desktops", label: "nav.remoteDesktop", icon: MonitorPlay },
  { id: "search", label: "search.title", icon: Search },
] as const

const activePanel = computed(() => sidebarPanel.panel.value)

/** Machine-local conversation routes that belong under Conversations on initial deep links. */
const conversationRouteNames = new Set([
  "new-session", "new-project", "manual-session", "workspace-agent",
  "session", "worktree", "machine-control", "terminal", "super-agent",
])

// Keep deep links and browser Back/Forward synced with the sidebar panel without snapping away
// when the user opens a session or schedule from inside the Search or Remote desktop panels.
watch(() => route.name, (name, prev) => {
  if (name === "remote-desktops") {
    sidebarPanel.panel.value = "desktops"
  } else if (name === "search") {
    sidebarPanel.panel.value = "search"
  } else if (name === "schedules" && sidebarPanel.panel.value !== "search") {
    sidebarPanel.panel.value = "schedules"
  } else if (prev === undefined && conversationRouteNames.has(String(name))) {
    sidebarPanel.panel.value = "conversations"
  }
}, { immediate: true })

function selectPanel(id: SidebarPanel): void {
  sidebarPanel.panel.value = id
}

function onTabKeydown(event: KeyboardEvent, index: number): void {
  const buttons = [...(tablist.value?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])]
  if (!buttons.length) return
  let nextIndex = -1
  if (event.key === "ArrowRight") nextIndex = (index + 1) % buttons.length
  else if (event.key === "ArrowLeft") nextIndex = (index - 1 + buttons.length) % buttons.length
  else if (event.key === "Home") nextIndex = 0
  else if (event.key === "End") nextIndex = buttons.length - 1
  if (nextIndex >= 0) {
    event.preventDefault()
    buttons[nextIndex]?.focus()
  }
}
</script>

<template>
  <nav :aria-label="t('nav.label')" class="app-no-drag shrink-0 px-2 pb-1.5">
    <div ref="tablist" role="tablist" :aria-label="t('nav.label')" class="flex min-w-0 flex-nowrap items-center gap-1">
      <UiTooltip v-for="(section, index) in sections" :key="section.id" :text="t(section.label)">
        <button
          :id="`sidebar-tab-${section.id}`"
          type="button"
          role="tab"
          :aria-label="t(section.label)"
          :aria-selected="activePanel === section.id"
          :tabindex="activePanel === section.id ? 0 : -1"
          :data-sidebar-tab="section.id"
          class="section-link ui-nav-item h-9 min-w-9 justify-center rounded-full px-2.5 text-[13px]"
          :class="activePanel === section.id && 'ui-nav-active'"
          @click="selectPanel(section.id)"
          @keydown="onTabKeydown($event, index)"
        >
          <component :is="section.icon" :size="16" :stroke-width="1.75" class="shrink-0" aria-hidden="true" />
          <span v-spring="{ maxWidth: activePanel === section.id ? '12rem' : '0rem', marginInlineStart: activePanel === section.id ? '0.5rem' : '0rem' }" class="section-label truncate" aria-hidden="true">{{ t(section.label) }}</span>
        </button>
      </UiTooltip>
    </div>
  </nav>
</template>

<style scoped>
.section-link {
  min-width: 2.25rem;
  flex-shrink: 0;
  gap: 0;
}
.section-link[aria-selected="true"] { flex-shrink: 1; }
.section-label {
  max-width: 0;
  margin-inline-start: 0;
  opacity: 0;
  transition: opacity var(--ui-duration-fast) var(--ui-ease-out);
}
.section-link[aria-selected="true"] .section-label {
  max-width: 12rem;
  margin-inline-start: 0.5rem;
  opacity: 1;
}
@media (prefers-reduced-motion: reduce) {
  .section-link, .section-label { transition: none; }
}
</style>
