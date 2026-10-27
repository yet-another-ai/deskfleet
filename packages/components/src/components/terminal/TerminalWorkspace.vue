<script setup lang="ts">
import UiButton from "../common/UiButton.vue"
import { Bot, Circle, CircleAlert, CircleStop, LoaderCircle, Plus, SquareTerminal, Unplug, X } from "@lucide/vue"
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from "reka-ui"
import { onMounted, ref, watch, type Component } from "vue"
import { useI18n } from "vue-i18n"
import type { TerminalSummary } from "../../../../../apps/daemon/src/terminal-protocol.ts"
import { useTerminalsStore } from "../../stores/terminals.ts"
import LiveTerminal, { type TerminalConnection } from "./LiveTerminal.vue"

/** Tabs over one owner's shells; the parent decides how the active tab is stored. */
const props = defineProps<{
  terminals: Pick<TerminalSummary, "id" | "cwd" | "kind">[]
  create: () => Promise<Pick<TerminalSummary, "id">>
  ensureTerminal?: () => Promise<Pick<TerminalSummary, "id">>
  readOnly?: boolean
}>()
const activeId = defineModel<string | undefined>("activeId")
const store = useTerminalsStore()
const { t } = useI18n()
const creating = ref(false)
const closing = ref(new Set<string>())
const error = ref<string | null>(null)
// The running program's reported title, or a numbered shell until one arrives.
const tabName = (id: string, index: number) => store.titles[id]?.trim() || (props.terminals[index]?.kind === "acp" ? t("terminal.agent") : t("terminal.tab", { number: index + 1 }))
const agentTerminal = (id: string) => props.terminals.find(terminal => terminal.id === id)?.kind === "acp"
const connection = ref<{ state: TerminalConnection; label: string }>({ state: "connecting", label: "" })
// Remounting the live view reattaches it, replaying history from the daemon.
const attempt = ref(0)
const icons: Record<TerminalConnection, { icon: Component; class: string }> = {
  connecting: { icon: LoaderCircle, class: "animate-spin text-ui-text-muted" },
  replaying: { icon: LoaderCircle, class: "animate-spin text-ui-text-muted" },
  connected: { icon: Circle, class: "fill-current text-ui-success" },
  disconnected: { icon: Unplug, class: "text-ui-warning" },
  ended: { icon: CircleStop, class: "text-ui-text-muted" },
  error: { icon: CircleAlert, class: "text-ui-danger" },
}
const broken = () => connection.value.state === "disconnected" || connection.value.state === "error"
function reconnect(): void {
  if (broken()) attempt.value++
}

function failed(reason: unknown): void {
  error.value = reason instanceof Error ? reason.message : String(reason)
}

function select(id: string): void {
  if (activeId.value !== id) connection.value = { state: "connecting", label: "" }
  activeId.value = id
}

async function create(start = props.create): Promise<void> {
  if (props.readOnly || creating.value) return
  creating.value = true
  error.value = null
  try { await select((await start()).id) }
  catch (reason) { failed(reason) }
  finally { creating.value = false }
}

async function hangup(id: string): Promise<void> {
  if (props.readOnly || agentTerminal(id) || closing.value.has(id)) return
  closing.value.add(id)
  error.value = null
  try { await store.hangup(id) }
  catch (reason) { failed(reason) }
  finally { closing.value.delete(id) }
}

// A hung-up tab hands focus to its neighbour; with no active tab, the first is shown.
function follow(ids: string[], previous: string[]): void {
  const active = activeId.value
  if (active && previous.includes(active) && !ids.includes(active)) {
    activeId.value = ids[Math.min(previous.indexOf(active), ids.length - 1)]
  } else if (!active && ids[0]) {
    activeId.value = ids[0]
  }
}
const ids = () => props.terminals.map(({ id }) => id)
watch(ids, (next, previous) => follow(next, previous))
// The parent's model listener is attached once mounted.
onMounted(() => {
  follow(ids(), [])
  if (!props.readOnly && !props.terminals.some(terminal => terminal.kind !== "acp") && props.ensureTerminal) void create(props.ensureTerminal)
})
</script>

<template>
  <TabsRoot :model-value="activeId" class="flex min-h-0 flex-1 flex-col" @update:model-value="select">
    <div class="flex h-8 min-w-0 shrink-0 items-center border-b border-ui-border">
      <TabsList :aria-label="t('terminal.tabs')" class="flex h-full min-w-0 flex-1 overflow-x-auto" loop>
        <div
          v-for="(terminal, index) in terminals"
          :key="terminal.id"
          role="presentation"
          class="group flex h-full max-w-56 shrink-0 items-center border-r border-ui-border"
          :class="activeId === terminal.id ? 'bg-ui-active text-ui-text' : 'text-ui-text-muted hover:bg-ui-hover hover:text-ui-text'"
        >
          <button
            v-if="activeId === terminal.id"
            type="button"
            class="ml-2 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded"
            :class="broken() ? 'cursor-pointer hover:bg-ui-hover' : 'cursor-default'"
            :title="broken() ? `${connection.label} · ${t('terminal.reconnect')}` : connection.label"
            :aria-label="broken() ? `${connection.label} · ${t('terminal.reconnect')}` : connection.label"
            role="status"
            :data-connection="connection.state"
            @click="reconnect"
          ><component :is="icons[connection.state].icon" :size="connection.state === 'connected' ? 8 : 13" :stroke-width="2" :class="icons[connection.state].class" aria-hidden="true" /></button>
          <TabsTrigger
            :value="terminal.id"
            :data-terminal-id="terminal.id"
            :title="`${tabName(terminal.id, index)} — ${terminal.cwd}`"
            class="inline-flex h-full min-w-0 cursor-pointer items-center gap-1.5 pr-1 text-[13px]"
            :class="activeId === terminal.id ? 'pl-1.5' : 'pl-3'"
            @keydown.delete.prevent="hangup(terminal.id)"
          >
            <component :is="terminal.kind === 'acp' ? Bot : SquareTerminal" :size="13" class="shrink-0" aria-hidden="true" />
            <span class="truncate">{{ tabName(terminal.id, index) }}</span>
            <span v-if="terminal.kind === 'acp'" class="shrink-0 text-[10px] text-ui-text-muted">{{ t('terminal.readOnly') }}</span>
          </TabsTrigger>
          <button
            v-if="terminal.kind !== 'acp'"
            type="button"
            :aria-label="t('terminal.hangupTab', { name: tabName(terminal.id, index) })"
            :title="t('terminal.hangupHint')"
            :disabled="readOnly || closing.has(terminal.id)"
            class="mr-1 inline-flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded opacity-0 hover:bg-ui-hover group-hover:opacity-100 focus-visible:opacity-100 disabled:op-40"
            :class="activeId === terminal.id && 'opacity-100'"
            @click="hangup(terminal.id)"
          ><X :size="13" aria-hidden="true" /></button>
        </div>
      </TabsList>
      <button
        type="button"
        :aria-label="t('terminal.newTab')"
        :title="t('terminal.newTab')"
        :disabled="readOnly || creating"
        class="inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded text-ui-text-muted hover:bg-ui-hover hover:text-ui-text disabled:op-40"
        @click="create()"
      ><Plus :size="15" aria-hidden="true" /></button>
      <slot name="actions" />
    </div>
    <p v-if="error" role="alert" class="m-0 truncate px-2 py-1 text-xs text-ui-danger" :title="error">{{ error }}</p>
    <TabsContent
      v-if="activeId && terminals.some(({ id }) => id === activeId)"
      :key="activeId"
      :value="activeId"
      class="flex min-h-0 flex-1 flex-col"
    ><LiveTerminal
      :key="`${activeId}:${attempt}`"
      :terminal-id="activeId"
      :read-only="readOnly || agentTerminal(activeId)"
      @connection="(state, label) => { connection = { state, label } }"
      @title="title => { store.titles[activeId!] = title }"
    /></TabsContent>
    <div v-else class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-sm text-ui-text-muted">
      <p class="m-0">{{ t("terminal.empty") }}</p>
      <UiButton
        type="button"
        :disabled="readOnly || creating"
        @click="create()"
      >{{ t("terminal.newTab") }}</UiButton>
    </div>
  </TabsRoot>
</template>
