<script setup lang="ts">
import { ArrowUp, ArrowUpRight, ChevronRight, History, Layers3, ListTree, LoaderCircle, MessageSquare, Orbit, SquarePen, UsersRound } from "@lucide/vue"
import { useFocus, useScroll } from "@vueuse/core"
import { computed, defineAsyncComponent, nextTick, ref, useTemplateRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import { intlLocale, type AppLocale } from "@deskfleet/client/i18n"
import PaneHeader from "../components/chrome/PaneHeader.vue"
import ErrorNotice from "../components/common/ErrorNotice.vue"
import UiButton from "../components/common/UiButton.vue"
import UiScrollArea from "../components/common/UiScrollArea.vue"
import { useAccountSession } from "../composables/account-session-context.ts"
import { usePlatformClient } from "../composables/usePlatformClient.ts"
import { useSuperAgent } from "../composables/useSuperAgent.ts"
import { formatMessageTime } from "../services/agent-format.ts"

const AgentMarkdown = defineAsyncComponent(() => import("../components/session/AgentMarkdown.vue"))
const { t, locale } = useI18n()
const account = useAccountSession()
const platform = usePlatformClient()
const { sessions, selected, title, usage, messages, status, pending, draft, loadingList, loadingHistory, sending, canSend,
  listError, usageError, readError, sendError, loadSessions, readHistory, refreshUsage, select, send } = useSuperAgent()
const showHistory = ref(false)
const historyToggle = useTemplateRef<HTMLButtonElement>("historyToggle")
const historyClose = useTemplateRef<HTMLButtonElement>("historyClose")
const textarea = useTemplateRef<HTMLTextAreaElement>("textarea")
const { focused } = useFocus(textarea)
const scroll = useTemplateRef<InstanceType<typeof UiScrollArea>>("scroll")
const viewport = computed(() => scroll.value?.viewportElement)
const { arrivedState } = useScroll(viewport, { offset: { bottom: 48 } })
const displayLocale = computed(() => intlLocale(locale.value as AppLocale))
const transcript = computed(() => pending.value.length ? [...messages.value, ...pending.value] : messages.value)
const teamName = computed(() => account?.team.value?.name ?? "")
const blocked = computed(() => {
  if (!usage.value || usage.value.admitted) return undefined
  if (!usage.value.runtimeConfigured) return "runtimeOffline"
  const allowance = usage.value.includedCredits === undefined ? usage.value.includedTokens : usage.value.includedCredits
  return allowance === 0 ? "noAllowance" : "quotaReached"
})
const suggestions = [{ label: "plan", prompt: "planPrompt", icon: Layers3 }, { label: "breakdown", prompt: "breakdownPrompt", icon: ListTree }] as const

watch(transcript, async (current, previous) => {
  if (!current.length || (previous.length > 0 && !arrivedState.bottom && !pending.value.length)) return
  await nextTick()
  const el = viewport.value
  if (el) el.scrollTop = el.scrollHeight
})
watch(() => account?.teamId.value, () => { showHistory.value = false })

async function toggleHistory(open: boolean): Promise<void> {
  showHistory.value = open
  await nextTick()
  if (open) historyClose.value?.focus()
  else historyToggle.value?.focus()
}
function open(id?: string): void {
  select(id)
  if (showHistory.value) void toggleHistory(false)
  if (!id && canSend.value) focused.value = true
}
function suggest(prompt: string): void {
  draft.value = prompt
  focused.value = true
}
function enter(event: KeyboardEvent): void {
  if (event.shiftKey || event.isComposing || event.keyCode === 229 || platform.mobile) return
  event.preventDefault()
  void send()
}
</script>

<template>
  <section class="super-agent-pane flex min-h-0 min-w-0 flex-1 flex-col">
    <component :is="account?.machine.value ? PaneHeader : 'header'" :class="!account?.machine.value && 'app-drag titlebar-overlay-inset flex h-12 shrink-0 items-center px-4'">
      <div class="flex min-w-0 items-center gap-2 text-sm font-medium"><Orbit :size="17" class="shrink-0 text-ui-accent" aria-hidden="true" />{{ t("superAgent.title") }}</div>
    </component>
    <div class="flex min-h-0 flex-1 border-t border-ui-border">
      <div class="conversation-column flex min-h-0 min-w-0 flex-1 flex-col">
        <header class="flex shrink-0 items-center justify-between gap-2 px-4 py-3 sm:px-6">
          <h1 class="m-0 min-w-0 truncate text-[15px] font-semibold" :title="title ?? undefined">
            {{ title || t(selected ? "superAgent.untitled" : "superAgent.new") }}
          </h1>
          <div class="flex shrink-0 items-center gap-1">
            <button ref="historyToggle" type="button" class="history-toggle ui-button-ghost h-8 px-2" :aria-expanded="showHistory" aria-controls="super-agent-history" @click="toggleHistory(!showHistory)">
              <History :size="15" aria-hidden="true" /><span>{{ t("superAgent.history") }}</span>
            </button>
            <UiButton v-if="selected" variant="ghost" size="icon" :label="t('superAgent.new')" :disabled="sending" @click="open()"><SquarePen :size="16" aria-hidden="true" /></UiButton>
          </div>
        </header>

        <div v-if="loadingList || loadingHistory" class="grid min-h-0 flex-1 place-content-center">
          <p role="status" class="flex items-center gap-2 text-sm text-ui-text-muted"><LoaderCircle :size="16" class="animate-spin" aria-hidden="true" />{{ t(loadingList ? 'superAgent.loadingList' : 'superAgent.loading') }}</p>
        </div>
        <UiScrollArea v-else ref="scroll" class="min-h-0 flex-1" :fade="false" viewport-class="px-4 sm:px-6" content-class="flex min-h-full flex-col">
          <div v-if="listError || readError" class="mx-auto w-full max-w-160 py-3">
            <ErrorNotice :error="listError ?? readError" :title="t(listError ? 'superAgent.listError' : 'superAgent.readError')">
              <UiButton size="sm" @click="listError ? loadSessions() : readHistory()">{{ t("errors.retry") }}</UiButton>
            </ErrorNotice>
          </div>
          <div v-if="!transcript.length && !readError && !listError" class="mx-auto my-auto w-full max-w-144 py-6 sm:py-10">
            <div class="mb-5 inline-flex size-13 items-center justify-center rounded-2xl border border-ui-accent/18 bg-ui-accent/8 text-ui-accent"><Orbit :size="32" :stroke-width="1.5" aria-hidden="true" /></div>
            <h2 class="m-0 text-balance text-[clamp(1.65rem,3.5cqw,2.35rem)] font-semibold leading-tight tracking-tight">{{ t("superAgent.heading") }}</h2>
            <p class="m-0 mt-2.5 max-w-98 text-pretty text-[15px] leading-6 text-ui-text-muted">{{ t("superAgent.intro") }}</p>
            <div v-if="canSend" class="mt-6 flex flex-wrap gap-2">
              <button v-for="item in suggestions" :key="item.label" type="button" class="ui-button gap-2 rounded-xl px-3 py-2" @click="suggest(t('superAgent.' + item.prompt))">
                <component :is="item.icon" :size="15" class="text-ui-accent" aria-hidden="true" />{{ t('superAgent.' + item.label) }}<ArrowUpRight :size="13" class="text-ui-text-faint" aria-hidden="true" />
              </button>
            </div>
          </div>
          <div v-else-if="transcript.length" class="mx-auto w-full max-w-160 select-text py-5" role="log" :aria-label="t('superAgent.title')" aria-live="polite" aria-relevant="additions">
            <article v-for="message in transcript" :key="message.id" :data-message-role="message.role" class="mb-6 min-w-0 last:mb-0" :class="message.role === 'user' && 'flex flex-col items-end pl-7'">
              <div class="mb-1.5 flex items-center gap-2 text-xs text-ui-text-muted">
                <Orbit v-if="message.role === 'assistant'" :size="15" class="text-ui-accent" aria-hidden="true" />
                <span class="font-medium">{{ t(message.role === 'assistant' ? 'superAgent.title' : 'superAgent.teamMember') }}</span>
                <time :datetime="message.at" class="text-ui-text-faint">{{ formatMessageTime(message.at, displayLocale) }}</time>
              </div>
              <p v-if="message.role === 'user'" class="m-0 max-w-full whitespace-pre-wrap break-words rounded-2xl bg-ui-accent/8 px-4 py-2.5 text-[15px] leading-6">{{ message.text }}</p>
              <AgentMarkdown v-else :text="message.text" class="min-w-0 break-words text-[15px] leading-6" />
            </article>
            <p v-if="(pending.length && status !== 'failed' && status !== 'ended') || status === 'working'" role="status" class="m-0 mt-4 flex items-center gap-2 text-[13px] text-ui-text-muted">
              <LoaderCircle :size="14" class="animate-spin" aria-hidden="true" />{{ t(pending.length ? 'superAgent.queued' : 'superAgent.working') }}
            </p>
          </div>
        </UiScrollArea>

        <div class="mx-auto w-full max-w-178 shrink-0 px-4 pb-4 pt-2 sm:px-6 sm:pb-6">
          <p v-if="status === 'failed'" role="status" class="ui-notice mb-2 border-ui-danger/25 bg-ui-danger/5 text-ui-danger">{{ t('superAgent.failed') }}</p>
          <ErrorNotice v-if="sendError || usageError" :error="sendError ?? usageError" :title="t(sendError ? 'superAgent.sendError' : 'superAgent.usageError')" class="mb-2">
            <UiButton size="sm" :disabled="sending || (!!sendError && !canSend)" @click="sendError ? send() : refreshUsage()">{{ t("errors.retry") }}</UiButton>
          </ErrorNotice>
          <div v-if="blocked || status === 'ended'" role="status" class="ui-notice mb-2 justify-between border-ui-border bg-ui-surface text-ui-text-muted">
            <span>{{ t('superAgent.' + (blocked ?? 'ended')) }}</span>
            <UiButton v-if="blocked === 'runtimeOffline'" size="sm" @click="refreshUsage">{{ t("errors.retry") }}</UiButton>
            <UiButton v-else-if="blocked && !platform.mobile" size="sm" @click="account?.openSettings('plans')">{{ t("errors.viewBilling") }}</UiButton>
            <UiButton v-else-if="!blocked" size="sm" @click="open()">{{ t("superAgent.new") }}</UiButton>
          </div>
          <form class="rounded-2xl border border-ui-border-strong bg-ui-surface p-3 shadow-ui-card focus-within:border-ui-accent/60" @submit.prevent="send">
            <textarea ref="textarea" v-model="draft" rows="2" class="block max-h-32 min-h-11 w-full resize-none select-text border-0 bg-transparent px-1 text-[15px] leading-6 outline-none [field-sizing:content]" :placeholder="t('superAgent.placeholder')" :aria-label="t('superAgent.placeholder')" :readonly="sending" :disabled="!canSend && !sending" @keydown.enter="enter" />
            <div class="mt-1 flex items-center justify-between gap-2">
              <span class="flex min-w-0 items-center gap-1.5 px-1 text-xs text-ui-text-muted"><UsersRound :size="14" class="shrink-0" aria-hidden="true" /><span class="truncate">{{ t('superAgent.shared', { team: teamName }) }}</span></span>
              <button type="submit" class="ui-button-primary size-8 shrink-0 rounded-full p-0" :disabled="!canSend || !draft.trim()" :aria-label="t('superAgent.send')" :title="t('superAgent.send')">
                <LoaderCircle v-if="sending" :size="17" class="animate-spin" aria-hidden="true" /><ArrowUp v-else :size="17" aria-hidden="true" />
              </button>
            </div>
          </form>
        </div>
      </div>

      <aside id="super-agent-history" class="history-rail min-h-0 shrink-0 flex-col border-l border-ui-border bg-ui-sidebar/45" :class="showHistory && 'history-open'" :aria-label="t('superAgent.history')" @keydown.esc="showHistory && toggleHistory(false)">
        <header class="flex h-13 shrink-0 items-center justify-between gap-2 px-4">
          <h2 class="m-0 flex items-center gap-2 text-[13px] font-semibold"><History :size="15" class="text-ui-text-muted" aria-hidden="true" />{{ t("superAgent.history") }}</h2>
          <button ref="historyClose" type="button" class="history-close ui-button-ghost h-7 w-7 p-0" :aria-label="t('common.close')" @click="toggleHistory(false)"><ChevronRight :size="16" aria-hidden="true" /></button>
        </header>
        <UiScrollArea class="min-h-0 flex-1" viewport-class="px-2 pb-3">
          <p v-if="!sessions.length && !loadingList && !listError" class="mx-2 my-2 max-w-50 text-[13px] leading-5 text-ui-text-muted">{{ t("superAgent.historyEmpty") }}</p>
          <ul v-else>
            <li v-for="session in sessions" :key="session.sessionId">
              <button type="button" class="flex w-full cursor-pointer items-start gap-2 rounded-lg px-2 py-2.5 text-left ui-motion disabled:cursor-default" :class="selected === session.sessionId ? 'bg-ui-accent/9' : 'hover:bg-ui-hover'" :disabled="sending" :aria-current="selected === session.sessionId ? 'true' : undefined" @click="open(session.sessionId)">
                <MessageSquare :size="14" class="mt-0.5 shrink-0" :class="selected === session.sessionId ? 'text-ui-accent' : 'text-ui-text-faint'" aria-hidden="true" />
                <span class="min-w-0"><span class="line-clamp-2 break-words text-[13px] leading-4.5">{{ session.title || t("superAgent.untitled") }}</span>
                  <time v-if="session.lastActiveAt > 0" :datetime="new Date(session.lastActiveAt).toISOString()" class="mt-1 block text-xs text-ui-text-faint">{{ formatMessageTime(new Date(session.lastActiveAt).toISOString(), displayLocale) }}</time>
                </span>
              </button>
            </li>
          </ul>
        </UiScrollArea>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.super-agent-pane { container-type: inline-size; position: relative; }
.history-rail { display: flex; width: clamp(12rem, 23cqw, 16rem); }
.history-toggle, .history-close { display: none; }
@container (max-width: 740px) {
  .history-toggle, .history-close { display: inline-flex; }
  .history-rail { display: none; }
  .conversation-column:has(+ .history-open) { visibility: hidden; }
  .history-rail.history-open { position: absolute; inset: 3rem 0 0; z-index: 2; display: flex; width: 100%; border-left: 0; background: var(--ui-color-canvas); }
}
</style>
