<script setup lang="ts">
import { CalendarClock, MessagesSquare, SquarePen } from "@lucide/vue"
import { storeToRefs } from "pinia"
import { computed, watch } from "vue"
import { useI18n } from "vue-i18n"
import { RouterLink, useRoute } from "vue-router"
import { useLayoutStore } from "../../stores/layout.ts"
import UiTooltip from "../common/UiTooltip.vue"
import SidebarLink from "./SidebarLink.vue"

const { t } = useI18n()
const route = useRoute()
const { conversationPath } = storeToRefs(useLayoutStore())
// Only the active section reveals its label, leaving room for more destinations.
const sections = [
  { routeName: "new-session", label: "nav.conversations", icon: MessagesSquare },
  { routeName: "schedules", label: "schedules.title", icon: CalendarClock },
] as const
type Section = typeof sections[number]
/** Named routes that belong under Conversations; Settings and Schedules are excluded. */
const conversationRouteNames = new Set(["new-session", "session", "workspace", "worktree", "machine-control", "terminal"])
const activeSection = computed(() => sections.find(section => section.routeName === route.name)
  ?? (conversationRouteNames.has(String(route.name)) ? sections[0] : undefined))

watch(() => route.fullPath, () => {
  // Skip transient unmatched routes during remount (name is briefly undefined at "/").
  if (typeof route.name === "string" && conversationRouteNames.has(route.name)) conversationPath.value = route.fullPath
}, { immediate: true })

function destination(section: Section) {
  // Clicking the current capsule keeps the selected session or task open.
  if (section === activeSection.value) return route.fullPath
  return section.routeName === "new-session" ? conversationPath.value : { name: section.routeName }
}
</script>

<template>
  <nav :aria-label="t('nav.label')" class="app-no-drag flex shrink-0 flex-col gap-1.5 px-2">
    <div class="flex min-w-0 items-center gap-1">
      <RouterLink v-for="section in sections" :key="section.routeName" v-slot="{ href, navigate }" :to="destination(section)" custom>
        <UiTooltip :text="t(section.label)">
          <a
            :href="href" :aria-label="t(section.label)"
            :aria-current="section === activeSection ? 'page' : undefined"
            class="section-link flex h-9 min-w-9 items-center justify-center rounded-full px-2.5 text-[13px] font-medium text-ui-text-muted hover:bg-ui-hover hover:text-ui-text"
            @click="navigate"
          >
            <component :is="section.icon" :size="16" :stroke-width="1.75" class="shrink-0" aria-hidden="true" />
            <span class="section-label truncate" aria-hidden="true">{{ t(section.label) }}</span>
          </a>
        </UiTooltip>
      </RouterLink>
    </div>
    <SidebarLink :to="{ name: 'new-session' }" :icon="SquarePen" :label="t('nav.newSession')" />
  </nav>
</template>

<style scoped>
.section-link {
  min-width: 2.25rem;
  transition: background-color 150ms ease, color 150ms ease;
}
.section-label {
  max-width: 0;
  margin-inline-start: 0;
  opacity: 0;
  transition: max-width 180ms ease, margin-inline-start 180ms ease, opacity 150ms ease;
}
.section-link[aria-current="page"] {
  background: var(--ui-color-active);
  color: var(--ui-color-text);
}
.section-link[aria-current="page"] .section-label {
  max-width: 12rem;
  margin-inline-start: 0.5rem;
  opacity: 1;
}
@media (prefers-reduced-motion: reduce) {
  .section-link, .section-label { transition: none; }
}
</style>
