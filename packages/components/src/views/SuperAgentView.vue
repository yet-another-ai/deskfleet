<script setup lang="ts">
import { intlLocale, type AppLocale } from "@deskfleet/client/i18n"
import { Check, Cloud, Cpu, History, Layers3, ListTree, LoaderCircle, Settings2, SquarePen, UsersRound } from "@lucide/vue"
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuTrigger } from "reka-ui"
import { computed, nextTick, ref, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"
import type { SuperAgentSession } from "@deskfleet/client/super-agent"
import ResourcePath from "../components/chrome/ResourcePath.vue"
import ErrorNotice from "../components/common/ErrorNotice.vue"
import SpringSurface from "../components/common/SpringSurface.ts"
import UiButton from "../components/common/UiButton.vue"
import SessionComposer from "../components/composer/SessionComposer.vue"
import AgentConversation from "../components/session/AgentConversation.vue"
import AgentNotice from "../components/session/AgentNotice.vue"
import AgentOutline from "../components/session/AgentOutline.vue"
import SessionConversationPane from "../components/session/SessionConversationPane.vue"
import SessionHeader from "../components/session/SessionHeader.vue"
import SessionWelcome from "../components/session/SessionWelcome.vue"
import SuperAgentByoaHost from "../components/super-agent/SuperAgentByoaHost.vue"
import SuperAgentConfigDialog from "../components/super-agent/SuperAgentConfigDialog.vue"
import { useAccountSession } from "../composables/account-session-context.ts"
import { usePlatformClient } from "../composables/usePlatformClient.ts"
import { superAgentSessionKey, useSuperAgent } from "../composables/useSuperAgent.ts"
import { formatMessageTime } from "../services/agent-format.ts"
import { projectSuperAgentConversation } from "../services/super-agent-conversation.ts"

const { t, locale } = useI18n()
const account = useAccountSession()
const platform = usePlatformClient()
const {
  config, loadingConfig, configError, refreshConfig, applyConfig,
  sessions, selected, selectedKey, selectedSession, activeEngine, title, usage, messages, turns, previews, status, pending, draft, attachments,
  loadingList, loadingHistory, sending, canSend, canCancel, cancelling, listError, usageError, readError, sendError, cancelError,
  loadSessions, readHistory, refreshUsage, select, upsertSession, send, cancel,
} = useSuperAgent()

const composer = useTemplateRef<InstanceType<typeof SessionComposer>>("composer")
const configOpen = ref(false)
const switchingCloud = ref(false)

const projection = computed(() => projectSuperAgentConversation(messages.value, pending.value, turns.value, previews.value))
const readingId = computed(() => JSON.stringify(["super-agent", account?.account.value.serverUrl, account?.account.value.user?.id, account?.teamId.value, selectedKey.value]))
const displayLocale = computed(() => intlLocale(locale.value as AppLocale))
const loading = computed(() => loadingList.value || loadingHistory.value || (!selected.value && loadingConfig.value))
const startupStatus = computed(() => {
  if (status.value === "failed" || status.value === "ended") return undefined
  if (pending.value.length) return t("superAgent.queued")
  if (status.value === "working") return t("agent.working")
  return undefined
})
const blocked = computed(() => {
  if (activeEngine.value !== "hosted" || !usage.value || usage.value.admitted) return undefined
  if (!usage.value.runtimeConfigured) return { message: t("superAgent.runtimeOffline"), action: "retry" }
  const allowance = usage.value.includedCredits === undefined ? usage.value.includedTokens : usage.value.includedCredits
  return { message: allowance === 0 ? t("superAgent.noAllowance") : t("superAgent.quotaReached"), action: "billing" }
})
const suggestions = computed(() => [
  { label: t("superAgent.plan"), prompt: t("superAgent.planPrompt"), icon: Layers3 },
  { label: t("superAgent.breakdown"), prompt: t("superAgent.breakdownPrompt"), icon: ListTree },
])

const activeByoaMachineId = computed(() => selectedSession.value?.engine === "byoa"
  ? (selectedSession.value.machineId ?? undefined)
  : config.value?.byoa?.machineId)

const activeByoaMachine = computed(() => activeByoaMachineId.value
  ? account?.machines.value.find(machine => machine.id === activeByoaMachineId.value)
  : undefined)

const canConfigure = computed(() => !!config.value?.canConfigure)
const hasMachines = computed(() => (account?.machines.value.length ?? 0) > 0)

const headerSegments = computed(() => {
  if (activeEngine.value === "byoa") {
    const machine = selectedSession.value?.machineName ?? activeByoaMachine.value?.name ?? config.value?.byoa?.machineName
    const provider = selectedSession.value?.providerName ?? selectedSession.value?.providerId ?? config.value?.byoa?.providerName ?? config.value?.byoa?.providerId
    const detail = [machine, provider].filter(Boolean).join(" · ")
    return [t("superAgent.title"), detail || t("superAgent.byoaBadge")]
  }
  return [t("superAgent.title")]
})

function sessionSubtitle(session: SuperAgentSession): string {
  if (session.engine === "byoa") {
    const parts = [session.machineName, session.providerName || session.providerId].filter(Boolean)
    return parts.join(" · ") || t("superAgent.byoaBadge")
  }
  return t("superAgent.cloudBadge")
}

function newConversation(): void {
  select()
  void nextTick(() => composer.value?.focus())
}
function suggest(prompt: string): void {
  draft.value = prompt
  composer.value?.focus()
}

async function switchToCloud(): Promise<void> {
  const teamId = account?.teamId.value
  if (!teamId || !account || !canConfigure.value || switchingCloud.value) return
  switchingCloud.value = true
  try {
    const updated = await account.central.updateSuperAgentConfig(teamId, { mode: "hosted" })
    applyConfig(updated)
    select()
  } finally {
    switchingCloud.value = false
  }
}
</script>

<template>
  <SessionHeader has-actions :sidebar="!!account?.machine.value">
    <h1 class="inline text-sm font-medium">{{ title || t(selected ? "superAgent.untitled" : "superAgent.new") }}</h1>
    <ResourcePath :segments="headerSegments" />
    <template #actions>
      <div class="app-no-drag flex items-center gap-1">
        <UiButton
          v-if="config"
          variant="ghost"
          size="sm"
          class="h-7 gap-1.5 px-2 text-xs text-ui-text-muted"
          data-super-agent-config-trigger
          :title="t('superAgent.configure')"
          :aria-label="t('superAgent.configure')"
          @click="configOpen = true"
        >
          <Cpu v-if="config.mode === 'byoa'" :size="14" class="text-ui-accent" aria-hidden="true" />
          <Cloud v-else :size="14" aria-hidden="true" />
          <span class="hidden max-w-28 truncate sm:inline">{{ config.mode === "byoa" ? (config.byoa?.machineName || t("superAgent.byoaBadge")) : t("superAgent.cloudBadge") }}</span>
          <Settings2 :size="13" aria-hidden="true" />
        </UiButton>
        <DropdownMenuRoot :modal="false">
          <DropdownMenuTrigger :as="UiButton" variant="ghost" size="icon" :label="t('superAgent.history')" :disabled="loadingList || sending">
            <History :size="16" :stroke-width="1.75" aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuPortal>
            <DropdownMenuContent id="super-agent-history" :as="SpringSurface" align="end" :side-offset="4" :collision-padding="8" :aria-label="t('superAgent.history')" class="ui-menu z-50 max-h-[min(24rem,75dvh)] w-72 overflow-y-auto" loop>
              <p v-if="!sessions.length" class="m-2 text-xs text-ui-text-muted">{{ t("superAgent.historyEmpty") }}</p>
              <DropdownMenuItem
                v-for="session in sessions"
                :key="superAgentSessionKey(session)"
                as="button"
                type="button"
                class="ui-menu-item w-full items-start py-2"
                :aria-current="selectedKey === superAgentSessionKey(session) ? 'true' : undefined"
                @select="select(session)"
              >
                <Check v-if="selectedKey === superAgentSessionKey(session)" :size="14" class="mt-0.5 shrink-0" aria-hidden="true" />
                <span class="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
                  <span class="truncate">{{ session.title || t("superAgent.untitled") }}</span>
                  <span class="flex items-center gap-1 truncate text-[11px] text-ui-text-faint">
                    <Cpu v-if="session.engine === 'byoa'" :size="11" class="shrink-0" aria-hidden="true" />
                    <Cloud v-else :size="11" class="shrink-0" aria-hidden="true" />
                    <span class="truncate">{{ sessionSubtitle(session) }}</span>
                  </span>
                </span>
                <time v-if="session.lastActiveAt > 0" class="shrink-0 text-[11px] text-ui-text-faint" :datetime="new Date(session.lastActiveAt).toISOString()">{{ formatMessageTime(new Date(session.lastActiveAt).toISOString(), displayLocale) }}</time>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenuPortal>
        </DropdownMenuRoot>
        <UiButton v-if="selected" variant="ghost" size="icon" :label="t('superAgent.new')" :disabled="sending" @click="newConversation"><SquarePen :size="16" :stroke-width="1.75" aria-hidden="true" /></UiButton>
      </div>
    </template>
  </SessionHeader>

  <template v-if="activeEngine === 'byoa'">
    <SuperAgentByoaHost
      v-if="account?.teamId.value && activeByoaMachine"
      :key="`${account.teamId.value}:${activeByoaMachine.id}`"
      :team-id="account.teamId.value"
      :machine="activeByoaMachine"
      :session-id="selectedSession?.engine === 'byoa' ? selectedSession.sessionId : undefined"
      :target="config?.byoa ?? null"
      :session-meta="selectedSession?.engine === 'byoa' ? selectedSession : undefined"
      :can-configure="canConfigure"
      :hosted-configured="!!config?.hostedConfigured"
      @session-change="(session, selectIt) => upsertSession(session, selectIt)"
      @open-config="configOpen = true"
      @switch-to-cloud="switchToCloud"
    />
    <div v-else class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6">
      <AgentNotice :text="t(activeByoaMachineId ? 'superAgent.byoaMachineUnavailable' : 'superAgent.byoaNotConfigured')">
        <UiButton v-if="canConfigure" size="sm" @click="configOpen = true">{{ t("superAgent.configure") }}</UiButton>
        <UiButton v-if="canConfigure && config?.hostedConfigured" size="sm" :disabled="switchingCloud" @click="switchToCloud">{{ t("superAgent.switchToCloud") }}</UiButton>
      </AgentNotice>
    </div>
  </template>

  <SessionConversationPane v-else :reading-id="readingId" :loading="loading" :revision="projection" :ready="!!selected" :sidebar="!!account?.machine.value" show-composer composer-active>
    <template #default="{ focusedEntry }">
      <p v-if="loading" class="m-auto flex items-center gap-2 text-sm text-ui-text-muted" role="status"><LoaderCircle :size="16" :stroke-width="2" class="animate-spin" aria-hidden="true" />{{ t('agent.loading') }}</p>
      <AgentConversation v-else-if="projection.length || startupStatus" :session-id="selected" :projection="projection" :turns="turns" :startup-status="startupStatus" :unattributed-user-label="t('superAgent.teamMember')" :locate-entry="focusedEntry" />
      <SessionWelcome v-else-if="!listError && !readError && !configError && activeEngine === 'hosted'" :heading="t('superAgent.heading')">
        <p class="m-0 text-center text-sm text-ui-text-muted">{{ t("superAgent.intro") }}</p>
        <div v-if="canSend" class="mt-3 flex flex-wrap justify-center gap-2">
          <UiButton v-for="item in suggestions" :key="item.label" variant="ghost" @click="suggest(item.prompt)">
            <component :is="item.icon" :size="15" class="text-ui-accent" aria-hidden="true" />{{ item.label }}
          </UiButton>
        </div>
      </SessionWelcome>
    </template>
    <template #outline="{ activeEntry, locateEntry }">
      <AgentOutline v-if="projection.length" :projection="projection" :active="activeEntry" class="absolute left-1 top-1/2 z-20 max-h-[calc(100%-2rem)] -translate-y-1/2" @select="locateEntry" />
    </template>
    <template #notices>
      <ErrorNotice v-if="configError" :error="configError" :title="t('superAgent.configError')">
        <UiButton size="sm" @click="refreshConfig()">{{ t("errors.retry") }}</UiButton>
      </ErrorNotice>
      <ErrorNotice v-if="listError || readError" :error="listError ?? readError" :title="t(listError ? 'superAgent.listError' : 'superAgent.readError')">
        <UiButton size="sm" @click="listError ? loadSessions() : readHistory()">{{ t("errors.retry") }}</UiButton>
      </ErrorNotice>
      <AgentNotice v-if="status === 'failed'" tone="danger" :text="t('superAgent.failed')" />
      <AgentNotice v-if="cancelling" tone="progress" :text="t('superAgent.cancelling')" />
      <ErrorNotice v-if="cancelError" :error="cancelError" :title="t('superAgent.cancelError')" />
      <ErrorNotice v-if="sendError || usageError" :error="sendError ?? usageError" :title="t(sendError ? 'superAgent.sendError' : 'superAgent.usageError')">
        <UiButton size="sm" :disabled="sending || (!!sendError && !canSend)" @click="sendError ? send() : refreshUsage()">{{ t("errors.retry") }}</UiButton>
      </ErrorNotice>
      <AgentNotice v-if="blocked || status === 'ended'" :text="blocked?.message ?? t('superAgent.ended')">
        <UiButton v-if="blocked?.action === 'retry'" size="sm" @click="refreshUsage">{{ t("errors.retry") }}</UiButton>
        <UiButton v-else-if="blocked?.action === 'billing' && !platform.mobile" size="sm" @click="account?.openSettings('plans')">{{ t("errors.viewBilling") }}</UiButton>
        <UiButton v-if="blocked && canConfigure && hasMachines" size="sm" @click="configOpen = true">{{ t("superAgent.switchToByoa") }}</UiButton>
        <UiButton v-if="!blocked" size="sm" @click="newConversation">{{ t("superAgent.new") }}</UiButton>
      </AgentNotice>
    </template>
    <template #composer>
      <SessionComposer ref="composer" v-model="draft" v-model:attachments="attachments" :location="null" :hosted="{ sessionId: selected }" :disabled="!canSend" :submitting="sending" :can-cancel="canCancel" @submit="send" @cancel="cancel">
        <template #context>
          <span class="flex min-w-0 items-center gap-1.5 text-xs text-ui-text-muted"><UsersRound :size="14" class="shrink-0" aria-hidden="true" /><span class="truncate">{{ t('superAgent.shared', { team: account?.team.value?.name ?? '' }) }}</span></span>
        </template>
      </SessionComposer>
    </template>
  </SessionConversationPane>

  <SuperAgentConfigDialog
    v-if="configOpen && config && account?.teamId.value"
    :team-id="account.teamId.value"
    :config="config"
    :machines="account.machines.value"
    :local-machine-id="account.localMachineId.value"
    :api="account.central"
    @saved="applyConfig"
    @close="configOpen = false"
  />
</template>
