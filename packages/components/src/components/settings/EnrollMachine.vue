<script setup lang="ts">
import { onMounted, ref, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"
import type { CentralApi } from "@deskfleet/client/central"
const props = defineProps<{ central: CentralApi; teamId: string; serverUrl: string }>()
const emit = defineEmits<{ close: []; enrolled: [] }>()
const { t } = useI18n()
const dialog = useTemplateRef<HTMLDialogElement>("dialog")
const name = ref("")
const originId = ref("")
const localMachineId = ref("")
const credentials = ref("")
const busy = ref(false)
const error = ref<string>()
async function enroll() {
  busy.value = true; error.value = undefined
  try {
    const result = await props.central.enrollHeadless(props.teamId, { name: name.value.trim(), originId: originId.value.trim(), localMachineId: localMachineId.value.trim() })
    credentials.value = JSON.stringify({ machineId: result.machine.id, teamId: props.teamId, token: result.token }, null, 2)
    emit("enrolled")
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { busy.value = false }
}
onMounted(() => dialog.value?.showModal())
</script>

<template>
  <dialog ref="dialog" class="ui-dialog app-no-drag w-[36rem] max-w-[95vw] max-h-[85vh]" :aria-label="t('account.enrollHeadless')" @close="emit('close')">
    <div class="mb-5 flex items-center justify-between gap-4"><h2 class="m-0 text-lg font-semibold">{{ t('account.enrollHeadless') }}</h2><button class="catalog-button" @click="dialog?.close()">{{ t('account.close') }}</button></div>
    <p v-if="error" role="alert" class="text-sm text-ui-danger">{{ error }}</p>
    <template v-if="credentials">
      <p class="text-sm">{{ t('account.enrollmentSecret') }}</p>
      <pre class="overflow-x-auto rounded bg-ui-hover p-3 text-xs">deskfleet-daemon enroll --server-url {{ serverUrl }}</pre>
      <p class="text-sm text-ui-text-muted">{{ t('account.pasteCredentials') }}</p>
      <textarea readonly class="catalog-input h-40 font-mono text-xs" :aria-label="t('account.enrollmentCredentials')" :value="credentials" @focus="($event.target as HTMLTextAreaElement).select()" />
    </template>
    <form v-else class="flex flex-col gap-4" @submit.prevent="enroll">
      <p class="m-0 text-sm text-ui-text-muted">{{ t('account.enrollmentIdentity') }}</p>
      <pre class="m-0 rounded bg-ui-hover p-3 text-xs">deskfleet-daemon status</pre>
      <label class="flex flex-col gap-1.5 text-sm">{{ t('account.machineName') }}<input v-model="name" class="catalog-input" required :disabled="busy" /></label>
      <label class="flex flex-col gap-1.5 text-sm">originId<input v-model="originId" class="catalog-input font-mono" required :disabled="busy" /></label>
      <label class="flex flex-col gap-1.5 text-sm">machineId<input v-model="localMachineId" class="catalog-input font-mono" inputmode="numeric" pattern="[0-9]+" required :disabled="busy" /></label>
      <button class="catalog-button" :disabled="busy">{{ t('account.enrollHeadless') }}</button>
    </form>
  </dialog>
</template>
