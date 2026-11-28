<script setup lang="ts">
import { Zap } from "@lucide/vue"
import { useConfirmDialog } from "@vueuse/core"
import { computed, onBeforeUnmount, watch } from "vue"
import { useI18n } from "vue-i18n"
import ConfirmDialog from "../common/ConfirmDialog.vue"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"

const props = defineProps<{ machineId: string; workspaceId?: string; sessionId?: string; disabled?: boolean }>()
const { t } = useI18n()
const agents = useAgentSessionsStore()
const yoloEnabled = computed(() => props.sessionId ? !!agents.sessions[props.sessionId]?.yolo : agents.draftYolo)
const yoloConfirmation = useConfirmDialog()
const { isRevealed: confirmingYolo } = yoloConfirmation
watch(() => [props.machineId, props.workspaceId, props.sessionId, props.disabled], () => yoloConfirmation.cancel(), { flush: "sync" })
onBeforeUnmount(() => yoloConfirmation.cancel())
async function toggleYolo() {
  if (props.disabled || confirmingYolo.value) return
  const id = props.sessionId
  const next = !yoloEnabled.value
  if (next && (await yoloConfirmation.reveal()).isCanceled) return
  if (id) await agents.setYolo(id, next)
  else agents.draftYolo = next
}
</script>

<template>
  <button
    type="button"
    class="ui-text-button shrink-0 cursor-pointer leading-5 disabled:cursor-default disabled:opacity-50"
    :class="yoloEnabled && 'ui-nav-active'"
    :aria-pressed="yoloEnabled"
    :aria-label="t('composer.yoloHint')"
    :title="t('composer.yoloHint')"
    :disabled="disabled"
    data-composer-yolo
    @click="toggleYolo"
  >
    <Zap :size="14" :stroke-width="1.85" :fill="yoloEnabled ? 'currentColor' : 'none'" class="shrink-0" aria-hidden="true" />
  </button>
  <ConfirmDialog
    v-if="confirmingYolo"
    :title="t('composer.yoloConfirmation.title')"
    :description="t('composer.yoloConfirmation.description')"
    :confirm-label="t('composer.yoloConfirmation.confirm')"
    :confirm="async () => { yoloConfirmation.confirm() }"
    @close="yoloConfirmation.cancel()"
  />
</template>
