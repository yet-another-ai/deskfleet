<script setup lang="ts">
import { Plus, Trash2 } from "@lucide/vue"
import { computed, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { AgentProviderConfig, AgentProviderInput, AgentProviderTemplate, ProviderTestResult } from "../../../../../apps/daemon/src/provider-protocol.ts"
import IconButton from "../common/IconButton.vue"
import ProviderIconPicker from "./ProviderIconPicker.vue"

const props = defineProps<{
  initial?: AgentProviderConfig
  templates: AgentProviderTemplate[]
  disabled?: boolean
  save(provider: AgentProviderInput): Promise<void>
  test(provider: AgentProviderInput): Promise<ProviderTestResult>
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
const testing = ref(false)
const testResult = ref<{ ok: true; agentName: string } | { ok: false; error: string } | null>(null)
let testRevision = 0
let finished = false

watch(template, (value, previous) => {
  if (!name.value.trim() || name.value === props.templates.find(item => item.id === previous)?.name) {
    name.value = props.templates.find(item => item.id === value)!.name
  }
})

// A result describes the settings it tested; any later edit makes it stale.
// Invalidate synchronously so an edit and a Test click in one tick cannot race.
watch([template, binaryPath, environment], () => {
  testRevision += 1
  testing.value = false
  testResult.value = null
}, { deep: true, flush: "sync" })

/** Validates the form and returns the provider it describes, or reports why it cannot. */
function current(): AgentProviderInput | null {
  if (!name.value.trim()) { error.value = t("providers.nameRequired"); return null }
  const keys = environment.value.map(row => row.key.trim())
  if (keys.some(key => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key))) {
    error.value = t("providers.invalidEnvironmentKey"); return null
  }
  if (new Set(keys).size !== keys.length) { error.value = t("providers.duplicateEnvironmentKey"); return null }
  return {
    template: template.value,
    name: name.value.trim(),
    binaryPath: binaryPath.value.trim() || undefined,
    icon: icon.value,
    env: Object.fromEntries(environment.value.map((row, index) => [keys[index]!, row.value])),
  }
}

async function runTest(): Promise<void> {
  if (testing.value || saving.value || props.disabled) return
  error.value = null
  const provider = current()
  if (!provider) return
  const revision = ++testRevision
  testing.value = true
  testResult.value = null
  try {
    const result = await props.test(provider)
    if (revision === testRevision) testResult.value = { ok: true, agentName: result.agentName }
  } catch (reason) {
    if (revision === testRevision) testResult.value = { ok: false, error: reason instanceof Error ? reason.message : String(reason) }
  } finally {
    if (revision === testRevision) testing.value = false
  }
}

function cancel(): void {
  if (saving.value || finished) return
  finished = true
  dialog.value?.close()
  emit("cancel")
}
async function submit(): Promise<void> {
  if (saving.value || props.disabled) return
  error.value = null
  const provider = current()
  if (!provider) return
  saving.value = true
  try {
    await props.save(provider)
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
      <p v-if="testing" role="status" class="m-0 text-sm text-ui-text-muted" data-provider-test-result>{{ t("providers.testing") }}</p>
      <p v-else-if="testResult?.ok" role="status" class="m-0 text-sm text-ui-text-muted" data-provider-test-result>{{ t("providers.testSucceeded", { agent: testResult.agentName }) }}</p>
      <p v-else-if="testResult" role="alert" class="m-0 whitespace-pre-wrap break-words text-sm text-ui-danger" data-provider-test-result>{{ t("providers.testFailed", { error: testResult.error }) }}</p>
      <div class="mt-1 flex justify-end gap-2">
        <button type="button" class="catalog-button mr-auto" :title="t('providers.testDescription')" :disabled="testing || saving || disabled" @click="runTest">{{ testing ? t("providers.testing") : t("providers.test") }}</button>
        <button type="button" class="catalog-button" :disabled="saving" @click="cancel">{{ t("catalog.cancel") }}</button>
        <button type="submit" class="catalog-button" :disabled="saving || disabled">{{ saving ? t("catalog.saving") : t(initial ? "catalog.save" : "providers.add") }}</button>
      </div>
    </form>
  </dialog>
</template>
