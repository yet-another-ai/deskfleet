<script setup lang="ts">
import { Circle, CircleAlert, CircleStop, LoaderCircle, Plus, Unplug, X } from "@lucide/vue"
import { nextTick, onMounted, ref, watch, type Component } from "vue"
import { useI18n } from "vue-i18n"
import type { TerminalSummary } from "../../../../../../daemon/src/terminal-protocol.ts"
import { useTerminalsStore } from "../../stores/terminals.ts"
import LiveTerminal, { type TerminalConnection } from "./LiveTerminal.vue"

/** Tabs over one owner's shells; the parent decides how the active tab is stored. */
const props = defineProps<{ terminals: Pick<TerminalSummary, "id" | "cwd">[]; create: () => Promise<Pick<TerminalSummary, "id">> }>()
const activeId = defineModel<string | undefined>("activeId")
const store = useTerminalsStore()
const { t } = useI18n()
const creating = ref(false)
const closing = ref(new Set<string>())
const error = ref<string | null>(null)
// The running program's reported title, or a numbered shell until one arrives.
const tabName = (id: string, index: number) => store.titles[id]?.trim() || t("terminal.tab", { number: index + 1 })
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
const tabId = (id: string) => `terminal-tab-${id}`
const panelId = (id: string) => `terminal-panel-${id}`

function failed(reason: unknown): void {
  error.value = reason instanceof Error ? reason.message : String(reason)
}

async function select(id: string, focus = false): Promise<void> {
  if (activeId.value !== id) connection.value = { state: "connecting", label: "" }
  activeId.value = id
  if (focus) {
    await nextTick()
    document.getElementById(tabId(id))?.focus()
  }
}

async function create(): Promise<void> {
  if (creating.value) return
  creating.value = true
  error.value = null
  try { await select((await props.create()).id) }
  catch (reason) { failed(reason) }
  finally { creating.value = false }
}

async function hangup(id: string): Promise<void> {
  if (closing.value.has(id)) return
  closing.value.add(id)
  error.value = null
  try { await store.hangup(id) }
  catch (reason) { failed(reason) }
  finally { closing.value.delete(id) }
}

function keydown(event: KeyboardEvent, index: number): void {
  const count = props.terminals.length
  let next: number
  if (event.key === "ArrowRight") next = (index + 1) % count
  else if (event.key === "ArrowLeft") next = (index + count - 1) % count
  else if (event.key === "Home") next = 0
  else if (event.key === "End") next = count - 1
  else if (event.key === "Delete") {
    event.preventDefault()
    void hangup(props.terminals[index]!.id)
    return
  } else return
  event.preventDefault()
  void select(props.terminals[next]!.id, true)
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
onMounted(() => follow(ids(), []))
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="flex h-8 min-w-0 shrink-0 items-center border-b border-ui-border">
      <div role="tablist" :aria-label="t('terminal.tabs')" class="flex h-full min-w-0 flex-1 overflow-x-auto">
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
          <button
            :id="tabId(terminal.id)"
            role="tab"
            type="button"
            :aria-selected="activeId === terminal.id"
            :aria-controls="panelId(terminal.id)"
            :tabindex="activeId === terminal.id ? 0 : -1"
            :title="`${tabName(terminal.id, index)} — ${terminal.cwd}`"
            class="h-full min-w-0 cursor-pointer truncate pr-1 text-[13px]"
            :class="activeId === terminal.id ? 'pl-1.5' : 'pl-3'"
            @click="select(terminal.id)"
            @keydown="keydown($event, index)"
          >{{ tabName(terminal.id, index) }}</button>
          <button
            type="button"
            :aria-label="t('terminal.hangupTab', { name: tabName(terminal.id, index) })"
            :title="t('terminal.hangupHint')"
            :disabled="closing.has(terminal.id)"
            class="mr-1 inline-flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded opacity-0 hover:bg-ui-hover group-hover:opacity-100 focus-visible:opacity-100 disabled:op-40"
            :class="activeId === terminal.id && 'opacity-100'"
            @click="hangup(terminal.id)"
          ><X :size="13" aria-hidden="true" /></button>
        </div>
      </div>
      <button
        type="button"
        :aria-label="t('terminal.newTab')"
        :title="t('terminal.newTab')"
        :disabled="creating"
        class="inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded text-ui-text-muted hover:bg-ui-hover hover:text-ui-text disabled:op-40"
        @click="create"
      ><Plus :size="15" aria-hidden="true" /></button>
      <slot name="actions" />
    </div>
    <p v-if="error" role="alert" class="m-0 truncate px-2 py-1 text-xs text-ui-danger" :title="error">{{ error }}</p>
    <div
      v-if="activeId && terminals.some(({ id }) => id === activeId)"
      :id="panelId(activeId)"
      role="tabpanel"
      :aria-labelledby="tabId(activeId)"
      class="flex min-h-0 flex-1 flex-col"
    ><LiveTerminal
      :key="`${activeId}:${attempt}`"
      :terminal-id="activeId"
      @connection="(state, label) => { connection = { state, label } }"
      @title="title => { store.titles[activeId!] = title }"
    /></div>
    <div v-else class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-sm text-ui-text-muted">
      <p class="m-0">{{ t("terminal.empty") }}</p>
      <button
        type="button"
        :disabled="creating"
        class="catalog-button"
        @click="create"
      >{{ t("terminal.newTab") }}</button>
    </div>
  </div>
</template>
