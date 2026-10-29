<script setup lang="ts">
import { Bot, RotateCw } from "@lucide/vue"
import { watchImmediate } from "@vueuse/core"
import { computed, ref, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"
import type { AgentTerminalOutput } from "../../services/agent-conversation.ts"
import LiveTerminal, { type TerminalConnection } from "../terminal/LiveTerminal.vue"
import TerminalSurface from "../terminal/TerminalSurface.vue"

const props = defineProps<{ terminalId: string; output?: AgentTerminalOutput; live?: boolean }>()
const { t } = useI18n()
const title = ref("")
const attempt = ref(0)
const connection = ref<{ state: TerminalConnection; label: string }>({ state: "connecting", label: "" })
const recorded = useTemplateRef<InstanceType<typeof TerminalSurface>>("recorded")
const status = computed(() => {
  if (!props.output) return connection.value
  if (props.output.status === "exited") return {
    state: "ended",
    label: props.output.exitCode == null ? t("terminal.ended") : t("terminal.exited", { code: props.output.exitCode }),
  }
  return props.live ? { state: "connected", label: t("terminal.connected") }
    : { state: "ended", label: t("terminal.agentInterrupted") }
})
let rendered = ""
// Provider-owned command output is already journaled with its tool call.
// Replay on expansion and append only new text while the command is running.
watchImmediate([recorded, () => props.output?.output], ([surface, output], [previousSurface]) => {
  if (!surface) { rendered = ""; return }
  const text = output ?? ""
  if (surface !== previousSurface) rendered = ""
  if (!text.startsWith(rendered)) { surface.reset(); rendered = "" }
  if (text.length > rendered.length) surface.write(new TextEncoder().encode(text.slice(rendered.length)))
  rendered = text
}, { flush: "post" })
</script>

<template>
  <div class="overflow-hidden rounded-md border border-ui-border" :data-agent-terminal="terminalId">
    <div class="flex min-w-0 items-center gap-2 border-b border-ui-border px-2 py-1.5 text-xs text-ui-text-muted">
      <Bot :size="15" class="shrink-0" aria-hidden="true" />
      <span class="min-w-0 flex-1 truncate">{{ title || t('terminal.agent') }}</span>
      <span class="ui-badge shrink-0">{{ t('terminal.readOnly') }}</span>
      <span role="status" :data-connection="status.state" class="max-w-60 truncate" :title="status.label">{{ status.label }}</span>
      <button
        v-if="!output && (connection.state === 'error' || connection.state === 'disconnected')"
        type="button"
        :aria-label="t('terminal.reconnect')"
        :title="t('terminal.reconnect')"
        class="inline-flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded hover:bg-ui-hover"
        @click="attempt++"
      ><RotateCw :size="13" aria-hidden="true" /></button>
    </div>
    <div class="flex h-64 min-h-0 select-text">
      <TerminalSurface
        v-if="output"
        ref="recorded"
        tools
        convert-eol
        @title="value => { title = value }"
      />
      <LiveTerminal
        v-else
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
