<script setup lang="ts">
import { Check, Terminal } from "@lucide/vue"
import { nextTick, onMounted, ref, useId, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"
import type { CentralApi } from "@deskfleet/client/central"
const props = defineProps<{ central: CentralApi; teamId: string; serverUrl: string }>()
const emit = defineEmits<{ close: []; enrolled: [] }>()
const { t } = useI18n()
const id = useId()
const dialog = useTemplateRef<HTMLDialogElement>("dialog")
const nameInput = useTemplateRef<HTMLInputElement>("nameInput")
const credentialInput = useTemplateRef<HTMLTextAreaElement>("credentialInput")
const name = ref("")
const originId = ref("")
const localMachineId = ref("")
const credentials = ref("")
const busy = ref(false)
const error = ref<string>()
function close(): void { if (!busy.value) dialog.value?.close() }
async function enroll(): Promise<void> {
  if (busy.value) return
  busy.value = true; error.value = undefined
  try {
    const result = await props.central.enrollHeadless(props.teamId, { name: name.value.trim(), originId: originId.value.trim(), localMachineId: localMachineId.value.trim() })
    credentials.value = JSON.stringify({ machineId: result.machine.id, teamId: props.teamId, token: result.token }, null, 2)
    emit("enrolled")
    await nextTick(); credentialInput.value?.focus()
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { busy.value = false }
}
onMounted(() => { dialog.value?.showModal(); nameInput.value?.focus() })
</script>

<template>
  <dialog ref="dialog" class="ui-dialog app-no-drag w-[32rem] max-h-[85vh] overflow-y-auto" :aria-labelledby="`${id}-title`" @cancel.prevent="close" @close="emit('close')">
    <div class="mb-5 flex items-start gap-3">
      <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-ui-badge text-ui-text-muted" aria-hidden="true"><Check v-if="credentials" :size="19" /><Terminal v-else :size="19" :stroke-width="1.75" /></span>
      <div><h2 :id="`${id}-title`" class="m-0 text-base font-semibold">{{ t(credentials ? 'account.enrollmentReady' : 'account.enrollHeadless') }}</h2><p class="m-0 mt-1 text-[13px] text-ui-text-muted">{{ t(credentials ? 'account.enrollmentNextStep' : 'account.headlessDescription') }}</p></div>
    </div>
    <p v-if="error" role="alert" class="m-0 mb-4 text-sm text-ui-danger">{{ error }}</p>
    <template v-if="credentials">
      <p class="m-0 mb-3 text-[13px] text-ui-text-muted">{{ t('account.enrollmentSecret') }}</p>
      <pre class="m-0 mb-4 select-text overflow-x-auto rounded-lg border border-ui-border bg-ui-surface p-3 text-xs">deskfleet-daemon enroll --server-url {{ serverUrl }}</pre>
      <label class="flex flex-col gap-1.5 text-sm">{{ t('account.enrollmentCredentials') }}<textarea ref="credentialInput" readonly class="catalog-input h-36 font-mono text-xs" :value="credentials" :aria-describedby="`${id}-paste`" @focus="($event.target as HTMLTextAreaElement).select()" /></label>
      <p :id="`${id}-paste`" class="m-0 mt-2 text-xs text-ui-text-muted">{{ t('account.pasteCredentials') }}</p>
      <div class="mt-5 flex justify-end"><button type="button" class="catalog-button" @click="close">{{ t('account.done') }}</button></div>
    </template>
    <form v-else class="flex flex-col gap-4" @submit.prevent="enroll">
      <div class="rounded-lg border border-ui-border bg-ui-surface p-3"><p class="m-0 mb-2 text-[13px] text-ui-text-muted">{{ t('account.enrollmentIdentity') }}</p><pre class="m-0 select-text overflow-x-auto font-mono text-xs">deskfleet-daemon status</pre></div>
      <label class="flex flex-col gap-1.5 text-sm">{{ t('account.machineName') }}<input ref="nameInput" v-model="name" class="catalog-input" name="machine-name" required :disabled="busy" autocomplete="off" /></label>
      <div class="grid grid-cols-2 gap-3">
        <label class="flex min-w-0 flex-col gap-1.5 text-sm">{{ t('account.installationIdentity') }}<input v-model="originId" class="catalog-input font-mono text-[13px]" name="origin-id" placeholder="originId" required :disabled="busy" autocomplete="off" :spellcheck="false" /><span class="text-xs text-ui-text-muted">originId</span></label>
        <label class="flex min-w-0 flex-col gap-1.5 text-sm">{{ t('account.localMachineIdentity') }}<input v-model="localMachineId" class="catalog-input font-mono text-[13px]" name="local-machine-id" placeholder="machineId" inputmode="numeric" pattern="[0-9]+" required :disabled="busy" autocomplete="off" /><span class="text-xs text-ui-text-muted">machineId</span></label>
      </div>
      <div class="mt-1 flex justify-end gap-2"><button type="button" class="catalog-button" :disabled="busy" @click="close">{{ t('catalog.cancel') }}</button><button class="catalog-button" :disabled="busy">{{ busy ? t('catalog.saving') : t('account.addMachine') }}</button></div>
    </form>
  </dialog>
</template>
