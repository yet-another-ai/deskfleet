<script setup lang="ts">
import { CircleCheck, Copy, GitFork } from "@lucide/vue"
import { useTimeoutFn } from "@vueuse/core"
import { ref } from "vue"
import { useI18n } from "vue-i18n"
import IconButton from "../common/IconButton.vue"

const props = defineProps<{ text: string; canFork?: boolean; forkDisabled?: boolean }>()
const emit = defineEmits<{ fork: [] }>()
const { t } = useI18n()
const copied = ref(false)
const copyFailed = ref(false)
const { start: scheduleCopiedReset, stop: cancelCopiedReset } = useTimeoutFn(() => { copied.value = false }, 1500, { immediate: false })
async function copy(): Promise<void> {
  cancelCopiedReset()
  copied.value = false
  copyFailed.value = false
  try { await navigator.clipboard.writeText(props.text) }
  catch { copyFailed.value = true; return }
  copied.value = true
  scheduleCopiedReset()
}
</script>

<template>
  <div v-if="text || canFork" class="-my-1 flex opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
    <IconButton v-if="text" :icon="copied ? CircleCheck : Copy" :label="t(copied ? 'agent.copied' : 'agent.copy')" @click="copy" />
    <IconButton v-if="canFork" :icon="GitFork" :label="t('agent.fork')" :disabled="forkDisabled" @click="emit('fork')" />
  </div>
  <p v-if="copyFailed" role="alert" class="m-0 text-xs text-ui-danger">{{ t('agent.copyFailed') }}</p>
</template>
