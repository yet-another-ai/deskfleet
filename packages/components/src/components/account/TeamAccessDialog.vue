<script setup lang="ts">
import { onMounted, ref, useId, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"
import { useAccountSession } from "../../composables/useAccountSession.ts"

const props = defineProps<{ mode: "create" | "join" }>()
const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const id = useId()
const session = useAccountSession()!
const dialog = useTemplateRef<HTMLDialogElement>("dialog")
const input = useTemplateRef<HTMLInputElement>("input")
const value = ref("")
const pending = ref(false)
const error = ref<string>()

function close(): void { if (!pending.value) emit("close") }
async function submit(): Promise<void> {
  if (pending.value || !value.value.trim()) return
  pending.value = true
  error.value = undefined
  try {
    await (props.mode === "create" ? session.createTeam(value.value.trim()) : session.joinTeam(value.value.trim()))
    emit("close")
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { pending.value = false }
}
onMounted(() => { dialog.value?.showModal(); input.value?.focus() })
</script>

<template>
  <dialog ref="dialog" class="ui-dialog app-no-drag w-[26rem]" :aria-labelledby="`${id}-title`" @cancel.prevent="close">
    <form class="flex flex-col gap-4" @submit.prevent="submit">
      <div>
        <h2 :id="`${id}-title`" class="m-0 text-base font-semibold">{{ t(mode === "create" ? "team.create" : "team.join") }}</h2>
        <p class="m-0 mt-1 text-[13px] text-ui-text-muted">{{ t(mode === "create" ? "team.createDescription" : "team.joinDescription") }}</p>
      </div>
      <label class="flex flex-col gap-1.5 text-sm">
        {{ t(mode === "create" ? "team.name" : "team.inviteCode") }}
        <input ref="input" v-model="value" class="catalog-input" :class="mode === 'join' && 'font-mono text-[13px]'" :name="mode === 'create' ? 'team-name' : 'invite-code'" required maxlength="256" autocomplete="off" :spellcheck="mode === 'create'" :disabled="pending" />
      </label>
      <p v-if="error" role="alert" class="m-0 text-sm text-ui-danger">{{ error }}</p>
      <div class="flex justify-end gap-2">
        <button type="button" class="catalog-button" :disabled="pending" @click="close">{{ t("catalog.cancel") }}</button>
        <button type="submit" class="catalog-button" :disabled="pending || !value.trim()">{{ t(mode === "create" ? (pending ? "team.creating" : "team.createAction") : (pending ? "team.joining" : "team.joinAction")) }}</button>
      </div>
    </form>
  </dialog>
</template>
