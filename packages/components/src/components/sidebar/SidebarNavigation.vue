<script setup lang="ts">
import { CalendarClock, MessagesSquare, MonitorPlay, Search, SquarePen } from "@lucide/vue"
import { vSpring } from "../../directives/spring.ts"
import { storeToRefs } from "pinia"
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { RouterLink, useRoute } from "vue-router"
import { useLayoutStore } from "../../stores/layout.ts"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import UiTooltip from "../common/UiTooltip.vue"
import SidebarLink from "./SidebarLink.vue"

const { t } = useI18n()
const route = useRoute()
const { conversationPath } = storeToRefs(useLayoutStore())
const searchPath = useAccountSession()?.searchPath ?? ref("/search")
// Only the active section reveals its label, leaving room for more destinations.
const sections = [
  { routeName: "new-session", label: "nav.conversations", icon: MessagesSquare },
  { routeName: "schedules", label: "schedules.title", icon: CalendarClock },
  { routeName: "remote-desktops", label: "nav.remoteDesktop", icon: MonitorPlay },
  { routeName: "search", label: "search.title", icon: Search },
] as const
type Section = typeof sections[number]
/** Machine-local resource routes that belong under Conversations. */
const conversationRouteNames = new Set(["new-session", "session", "worktree", "machine-control", "terminal"])
const activeSection = computed(() => sections.find(section => section.routeName === route.name)
  ?? (conversationRouteNames.has(String(route.name)) ? sections[0] : undefined))

watch(() => route.fullPath, () => {
  // Skip transient unmatched routes during remount (name is briefly undefined at "/").
  if (typeof route.name === "string" && conversationRouteNames.has(route.name)) conversationPath.value = route.fullPath
  if (route.name === "search") searchPath.value = route.fullPath
}, { immediate: true })

function destination(section: Section) {
  // Clicking the current capsule keeps the selected session or task open.
  if (section === activeSection.value) return route.fullPath
  if (section.routeName === "search") return searchPath.value
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
            class="section-link ui-nav-item h-9 min-w-9 justify-center rounded-full px-2.5 text-[13px]"
            :class="section === activeSection && 'ui-nav-active'"
            @click="navigate"
          >
            <component :is="section.icon" :size="16" :stroke-width="1.75" class="shrink-0" aria-hidden="true" />
            <span v-spring="{ maxWidth: section === activeSection ? '12rem' : '0rem', marginInlineStart: section === activeSection ? '0.5rem' : '0rem' }" class="section-label truncate" aria-hidden="true">{{ t(section.label) }}</span>
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
  flex-shrink: 0;
  gap: 0;
}
.section-link[aria-current="page"] { flex-shrink: 1; }
.section-label {
  max-width: 0;
  margin-inline-start: 0;
  opacity: 0;
  transition: opacity var(--ui-duration-fast) var(--ui-ease-out);
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
