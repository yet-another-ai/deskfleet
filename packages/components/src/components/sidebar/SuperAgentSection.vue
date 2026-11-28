<script setup lang="ts">
import { withCentralRequestTrigger } from "@deskfleet/client/reporting-central"
import { ChevronRight, Orbit, SquarePen } from "@lucide/vue"
import { CollapsibleContent, CollapsibleRoot, CollapsibleTrigger } from "reka-ui"
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { RouterLink, useRoute, useRouter } from "vue-router"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import { useSidebarFilter } from "../../composables/useSidebarFilter.ts"
import {
  getSharedSuperAgentSessions,
  setSharedSuperAgentSessions,
  superAgentSessionKey,
} from "../../composables/useSuperAgentSessionsList.ts"
import UiButton from "../common/UiButton.vue"

const MAX_VISIBLE_SESSIONS = 10

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const account = useAccountSession()
const sidebarFilter = useSidebarFilter()

const open = ref(true)
const expanded = ref(false)
let loadRevision = 0

const enabled = computed(() => Boolean(account?.superAgentEnabled?.value))
const scope = computed(() => JSON.stringify([
  account?.account.value.serverUrl,
  account?.account.value.user?.id,
  account?.teamId.value,
]))
const sessions = computed(() => {
  return getSharedSuperAgentSessions(scope.value)?.filter(session => !session.archived) ?? []
})
const filtering = computed(() => sidebarFilter.filter.value !== "all")
const showSection = computed(() => enabled.value && !filtering.value)
const visibleSessions = computed(() => expanded.value ? sessions.value : sessions.value.slice(0, MAX_VISIBLE_SESSIONS))

const activeSessionKey = computed(() =>
  route.name === "super-agent" && typeof route.query.session === "string" ? route.query.session : undefined,
)
const isNewActive = computed(() => route.name === "super-agent" && !activeSessionKey.value)

async function load(): Promise<void> {
  const teamId = account?.teamId.value
  if (!account || !teamId || !enabled.value) return
  const currentScope = scope.value
  const revision = ++loadRevision
  const cached = getSharedSuperAgentSessions(currentScope)
  try {
    const automatic = withCentralRequestTrigger(account.central, "background")
    const list = await automatic.superAgentSessions(teamId)
    if (revision !== loadRevision || currentScope !== scope.value || cached !== getSharedSuperAgentSessions(currentScope)) return
    setSharedSuperAgentSessions(currentScope, list)
  } catch {
    // Keep any cached list; SuperAgentView reports interactive errors.
  }
}

watch([scope, enabled], ([, active]) => {
  if (active) void load()
}, { immediate: true })

function startNewConversation(): void {
  void router.push({ name: "super-agent", query: { new: "1" } })
}
</script>

<template>
  <CollapsibleRoot v-if="showSection" v-model:open="open" as="section" data-super-agent-section class="mb-4">
    <div class="group flex h-8 items-center rounded-lg pl-2.5 pr-1 ui-motion hover:bg-ui-hover">
      <CollapsibleTrigger
        type="button"
        class="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2.5 pr-1 text-left text-[13px] font-medium text-ui-text-muted ui-motion group-hover:text-ui-text"
      >
        <Orbit :size="15" :stroke-width="1.75" class="shrink-0" aria-hidden="true" />
        <span class="min-w-0 flex-1 truncate">{{ t("superAgent.title") }}</span>
      </CollapsibleTrigger>
      <div class="flex shrink-0 items-center gap-0.5">
        <div
          class="flex shrink-0 items-center text-ui-text-faint ui-motion can-hover:max-w-0 can-hover:overflow-hidden can-hover:op-0 can-hover:pointer-events-none group-hover:max-w-8 group-hover:op-100 group-hover:pointer-events-auto group-has-[:focus-visible]:max-w-8 group-has-[:focus-visible]:op-100 group-has-[:focus-visible]:pointer-events-auto"
        >
          <UiButton
            variant="ghost"
            size="icon"
            class="!h-6 !w-6 rounded-md text-current [&:not(:disabled,[aria-disabled=true])]:hover:bg-ui-text/8 [&:not(:disabled,[aria-disabled=true])]:hover:text-ui-text"
            :label="t('superAgent.new')"
            @click="startNewConversation"
          >
            <SquarePen :size="14" :stroke-width="1.75" aria-hidden="true" />
          </UiButton>
        </div>
        <CollapsibleTrigger
          type="button"
          tabindex="-1"
          aria-hidden="true"
          class="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-ui-text-faint ui-motion hover:bg-ui-text/8 hover:text-ui-text"
        >
          <ChevronRight :size="14" :stroke-width="1.75" class="ui-motion" :class="open && 'rotate-90'" aria-hidden="true" />
        </CollapsibleTrigger>
      </div>
    </div>

    <CollapsibleContent as="ul" class="m-0 mt-1 flex list-none flex-col gap-1 p-0 empty:hidden">
      <li v-if="visibleSessions.length === 0">
        <RouterLink
          :to="{ name: 'super-agent', query: { new: '1' } }"
          class="ui-nav-item pl-[35px] pr-2.5 text-[13px] no-underline"
          :class="isNewActive && 'ui-nav-active'"
          :aria-current="isNewActive ? 'page' : undefined"
        >
          <SquarePen :size="14" :stroke-width="1.75" class="shrink-0" aria-hidden="true" />
          <span class="min-w-0 flex-1 truncate">{{ t("superAgent.new") }}</span>
        </RouterLink>
      </li>
      <li v-for="session in visibleSessions" :key="superAgentSessionKey(session)">
        <RouterLink
          :to="{ name: 'super-agent', query: { session: superAgentSessionKey(session) } }"
          class="ui-nav-item pl-[35px] pr-2.5"
          :class="activeSessionKey === superAgentSessionKey(session) && 'ui-nav-active'"
          :aria-current="activeSessionKey === superAgentSessionKey(session) ? 'page' : undefined"
        >
          <span class="min-w-0 flex-1 truncate">{{ session.title || t("superAgent.untitled") }}</span>
        </RouterLink>
      </li>
      <li v-if="sessions.length > MAX_VISIBLE_SESSIONS">
        <button
          type="button"
          class="ui-nav-item w-full pl-[35px] pr-2.5 text-left text-xs text-ui-text-faint hover:text-ui-text"
          @click="expanded = !expanded"
        >
          {{ expanded ? t("sidebar.showFewerSessions") : t("sidebar.showMoreSessions", { count: sessions.length - MAX_VISIBLE_SESSIONS }) }}
        </button>
      </li>
    </CollapsibleContent>
  </CollapsibleRoot>
</template>
