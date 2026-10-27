<script setup lang="ts">
import { Bot, RotateCw } from "@lucide/vue"
import { ref } from "vue"
import { useI18n } from "vue-i18n"
import LiveTerminal, { type TerminalConnection } from "../terminal/LiveTerminal.vue"

defineProps<{ terminalId: string }>()
const { t } = useI18n()
const title = ref("")
const attempt = ref(0)
const connection = ref<{ state: TerminalConnection; label: string }>({ state: "connecting", label: "" })
</script>

<template>
  <div class="overflow-hidden rounded-md border border-ui-border" :data-agent-terminal="terminalId">
    <div class="flex min-w-0 items-center gap-2 border-b border-ui-border px-2 py-1.5 text-xs text-ui-text-muted">
      <Bot :size="15" class="shrink-0" aria-hidden="true" />
      <span class="min-w-0 flex-1 truncate">{{ title || t('terminal.agent') }}</span>
      <span class="ui-badge shrink-0">{{ t('terminal.readOnly') }}</span>
      <span role="status" :data-connection="connection.state" class="max-w-60 truncate" :title="connection.label">{{ connection.label }}</span>
      <button
        v-if="connection.state === 'error' || connection.state === 'disconnected'"
        type="button"
        :aria-label="t('terminal.reconnect')"
        :title="t('terminal.reconnect')"
        class="inline-flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded hover:bg-ui-hover"
        @click="attempt++"
      ><RotateCw :size="13" aria-hidden="true" /></button>
    </div>
    <div class="flex h-64 min-h-0 select-text">
      <LiveTerminal
        :key="`${terminalId}:${attempt}`"
        :terminal-id="terminalId"
        read-only
        independent
        @connection="(state, label) => { connection = { state, label } }"
        @title="value => { title = value }"
      />
    </div>
  </div>
</template>
