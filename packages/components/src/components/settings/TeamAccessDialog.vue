<script setup lang="ts">
import { onMounted, ref, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"

const props = defineProps<{ mode: "create" | "join"; busy: boolean; error?: string }>()
const emit = defineEmits<{ close: []; submit: [value: string] }>()
const { t } = useI18n()
const dialog = useTemplateRef<HTMLDialogElement>("dialog")
const value = ref("")
function close(): void { if (!props.busy) emit("close") }
onMounted(() => dialog.value?.showModal())
</script>

<template>
  <dialog ref="dialog" class="ui-dialog app-no-drag w-[28rem]" :aria-label="t(mode === 'create' ? 'account.createTeam' : 'account.joinTeam')" @cancel.prevent="close" @close="close">
    <form class="flex flex-col gap-5" @submit.prevent="emit('submit', value.trim())">
      <h2 class="m-0 text-base font-semibold">{{ t(mode === 'create' ? 'account.createTeam' : 'account.joinTeam') }}</h2>
      <label class="flex flex-col gap-2 text-[13px] text-ui-text-muted">{{ t(mode === 'create' ? 'account.teamName' : 'account.inviteCode') }}<input v-model="value" autofocus class="catalog-input text-ui-text" :disabled="busy" required /></label>
      <p v-if="error" role="alert" class="m-0 text-sm text-ui-danger">{{ error }}</p>
      <div class="flex justify-end gap-2"><button type="button" class="catalog-button" :disabled="busy" @click="close">{{ t('catalog.cancel') }}</button><button type="submit" class="catalog-button" :disabled="busy || !value.trim()">{{ t(mode === 'create' ? 'catalog.create' : 'account.joinTeam') }}</button></div>
    </form>
  </dialog>
</template>
