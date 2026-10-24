<script setup lang="ts">
import { Plus, Trash2 } from "@lucide/vue"
import { computed, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { AgentProviderConfig, AgentProviderInput, AgentProviderTemplate } from "../../../../../../daemon/src/provider-protocol.ts"
import IconButton from "../common/IconButton.vue"
import ProviderIconPicker from "./ProviderIconPicker.vue"

const props = defineProps<{
  initial?: AgentProviderConfig
  templates: AgentProviderTemplate[]
  disabled?: boolean
  save(provider: AgentProviderInput): Promise<void>
}>()
const emit = defineEmits<{ saved: []; cancel: [] }>()
const { t } = useI18n()
const dialog = useTemplateRef<HTMLDialogElement>("dialog")
const template = ref(props.initial?.template ?? props.templates[0]!.id)
const selectedTemplate = computed(() => props.templates.find(value => value.id === template.value)!)
const name = ref(props.initial?.name ?? selectedTemplate.value.name)
const binaryPath = ref(props.initial?.binaryPath ?? "")
const icon = ref(props.initial?.icon)
let nextRowId = 0
const environment = ref(Object.entries(props.initial?.env ?? {}).map(([key, value]) => ({ id: nextRowId++, key, value })))
const saving = ref(false)
const error = ref<string | null>(null)
let finished = false

watch(template, (value, previous) => {
  if (!name.value.trim() || name.value === props.templates.find(item => item.id === previous)?.name) {
    name.value = props.templates.find(item => item.id === value)!.name
  }
})

function cancel(): void {
  if (saving.value || finished) return
  finished = true
  dialog.value?.close()
  emit("cancel")
}
async function submit(): Promise<void> {
  if (saving.value || props.disabled) return
  error.value = null
  if (!name.value.trim()) { error.value = t("providers.nameRequired"); return }
  const keys = environment.value.map(row => row.key.trim())
  if (keys.some(key => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key))) {
    error.value = t("providers.invalidEnvironmentKey"); return
  }
  if (new Set(keys).size !== keys.length) { error.value = t("providers.duplicateEnvironmentKey"); return }
  saving.value = true
  try {
    await props.save({
      template: template.value,
      name: name.value.trim(),
      binaryPath: binaryPath.value.trim() || undefined,
      icon: icon.value,
      env: Object.fromEntries(environment.value.map((row, index) => [keys[index]!, row.value])),
    })
    finished = true
    dialog.value?.close()
    emit("saved")
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { saving.value = false }
}
onMounted(() => dialog.value?.showModal())
onBeforeUnmount(() => { finished = true; dialog.value?.close() })
</script>

<template>
  <dialog ref="dialog" class="ui-dialog app-no-drag w-[32rem] max-h-[85vh] overflow-y-auto" aria-labelledby="provider-dialog-title" @cancel.prevent="cancel" @close="cancel">
    <h2 id="provider-dialog-title" class="m-0 mb-5 text-base font-semibold">{{ t(initial ? "providers.edit" : "providers.add") }}</h2>
    <form class="flex flex-col gap-4" @submit.prevent="submit">
      <div class="flex flex-col gap-1.5 text-sm">
        <label for="provider-template">{{ t("providers.template") }}</label>
        <input v-if="initial" id="provider-template" class="catalog-input text-ui-text-muted" :value="selectedTemplate.name" readonly data-provider-template />
        <select v-else id="provider-template" v-model="template" class="catalog-input" :disabled="saving || disabled">
          <option v-for="item in templates" :key="item.id" :value="item.id">{{ item.name }}</option>
        </select>
        <p class="m-0 text-xs text-ui-text-muted">{{ t(`providers.templateDescription.${template}`) }}</p>
        <p v-if="initial" class="m-0 text-xs text-ui-text-muted">{{ t("providers.templateFixed") }}</p>
      </div>
      <label class="flex flex-col gap-1.5 text-sm">
        {{ t("providers.name") }}
        <input v-model="name" name="provider-name" class="catalog-input" required maxlength="256" :disabled="saving || disabled" autocomplete="off" />
      </label>
      <ProviderIconPicker v-model="icon" :template="template" :disabled="saving || disabled" />
      <label class="flex flex-col gap-1.5 text-sm">
        {{ t("providers.binaryPath") }}
        <input v-model="binaryPath" name="provider-binary" class="catalog-input font-mono text-[13px]" :placeholder="selectedTemplate.defaultBinaryPath" :disabled="saving || disabled" autocomplete="off" :spellcheck="false" />
        <span class="text-xs text-ui-text-muted">{{ t("providers.binaryDefault", { binary: selectedTemplate.defaultBinaryPath }) }}</span>
      </label>
      <fieldset class="m-0 min-w-0 border-0 p-0" :disabled="saving || disabled">
        <legend class="mb-1.5 text-sm">{{ t("providers.environment") }}</legend>
        <p class="m-0 mb-3 text-xs text-ui-text-muted">{{ t("providers.environmentDescription") }}</p>
        <div class="flex flex-col gap-2">
          <div v-for="(row, index) in environment" :key="row.id" class="flex items-center gap-2" data-environment-row>
            <input v-model="row.key" class="catalog-input min-w-0 flex-1 font-mono text-xs" :aria-label="t('providers.environmentKey', { n: index + 1 })" :placeholder="t('providers.key')" autocomplete="off" :spellcheck="false" />
            <input v-model="row.value" class="catalog-input min-w-0 flex-[1.4] font-mono text-xs" :aria-label="t('providers.environmentValue', { n: index + 1 })" :placeholder="t('providers.value')" autocomplete="off" :spellcheck="false" />
            <IconButton :icon="Trash2" :label="t('providers.removeEnvironment', { n: index + 1 })" :disabled="saving || disabled" @click="environment.splice(index, 1)" />
          </div>
          <button type="button" class="ui-text-button w-fit cursor-pointer hover:bg-ui-hover" @click="environment.push({ id: nextRowId++, key: '', value: '' })">
            <Plus :size="14" :stroke-width="1.75" aria-hidden="true" />{{ t("providers.addEnvironment") }}
          </button>
        </div>
      </fieldset>
      <p v-if="error" role="alert" class="m-0 text-sm text-ui-danger">{{ error }}</p>
      <div class="mt-1 flex justify-end gap-2">
        <button type="button" class="catalog-button" :disabled="saving" @click="cancel">{{ t("catalog.cancel") }}</button>
        <button type="submit" class="catalog-button" :disabled="saving || disabled">{{ saving ? t("catalog.saving") : t(initial ? "catalog.save" : "providers.add") }}</button>
      </div>
    </form>
  </dialog>
</template>
