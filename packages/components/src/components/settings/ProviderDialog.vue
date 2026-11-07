<script setup lang="ts">
import UiButton from "../common/UiButton.vue"
import UiSwitch from "../common/UiSwitch.vue"
import { ChevronLeft, ChevronRight, CircleCheck, CircleX, LoaderCircle, Plus, Trash2 } from "@lucide/vue"
import { CollapsibleContent, CollapsibleRoot, CollapsibleTrigger, DialogTitle, DialogDescription } from "reka-ui"
import { computed, nextTick, onBeforeUnmount, ref, useTemplateRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { AgentProviderConfig, AgentProviderInput, AgentProviderTemplate, AgentProviderTemplateId, ProviderProbeResult, ProviderTestResult } from "../../../../../apps/daemon/src/provider-protocol.ts"
import type { TerminalSummary } from "../../../../../apps/daemon/src/terminal-protocol.ts"
import ProviderIcon from "../common/ProviderIcon.vue"
import ProviderIconPicker from "./ProviderIconPicker.vue"
import ProviderSetup from "./ProviderSetup.vue"
import UiDialog from "../common/UiDialog.vue"

const props = withDefaults(defineProps<{
  initial?: AgentProviderConfig
  templates: AgentProviderTemplate[]
  disabled?: boolean
  machineName: string
  shellEnvironmentDefault?: boolean
  probe(provider: AgentProviderInput): Promise<ProviderProbeResult>
  install(provider: AgentProviderInput): Promise<TerminalSummary>
  login(provider: AgentProviderInput): Promise<TerminalSummary>
  save(provider: AgentProviderInput): Promise<void>
  test(provider: AgentProviderInput): Promise<ProviderTestResult>
}>(), { shellEnvironmentDefault: true })
const emit = defineEmits<{ saved: []; cancel: [] }>()
const { t } = useI18n()
const pathInput = useTemplateRef<HTMLInputElement>("pathInput")
// A new provider starts by choosing its agent; the template is fixed once created.
const step = ref<"template" | "details">(props.initial ? "details" : "template")
const template = ref(props.initial?.template ?? props.templates[0]!.id)
const selectedTemplate = computed(() => props.templates.find(value => value.id === template.value)!)
const name = ref(props.initial?.name ?? selectedTemplate.value.name)
const binaryPath = ref(props.initial?.binaryPath ?? "")
const icon = ref(props.initial?.icon)
const inheritShellEnvironment = ref(props.initial?.inheritShellEnvironment ?? props.shellEnvironmentDefault)
let nextRowId = 0
const environment = ref(Object.entries(props.initial?.env ?? {}).map(([key, value]) => ({ id: nextRowId++, key, value })))
const advanced = ref(!!props.initial?.binaryPath || environment.value.length > 0 || inheritShellEnvironment.value !== props.shellEnvironmentDefault)
const saving = ref(false)
const error = ref<string | null>(null)
const testing = ref(false)
const setupBusy = ref(false)
/** A running install or login owns the window so its terminal can use the full height. */
const setupExpanded = ref(false)
const resolvedBinaryPath = ref<string>()
const formDisabled = computed(() => saving.value || setupBusy.value || props.disabled)
const setupProvider = computed((): AgentProviderInput | null => {
  const keys = environment.value.map(row => row.key.trim())
  if (keys.some(key => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) || new Set(keys).size !== keys.length) return null
  return {
    template: template.value, name: selectedTemplate.value.name,
    binaryPath: binaryPath.value.trim() || undefined,
    inheritShellEnvironment: inheritShellEnvironment.value,
    env: Object.fromEntries(environment.value.map((row, index) => [keys[index]!, row.value])),
  }
})
/** Names the overrides hidden inside a collapsed Advanced section. */
const advancedSummary = computed(() => [
  ...(binaryPath.value.trim() ? [t("providers.customPath")] : []),
  ...(inheritShellEnvironment.value !== props.shellEnvironmentDefault ? [t("providers.shellEnvironment")] : []),
  ...(environment.value.length ? [t("providers.environmentCount", environment.value.length)] : []),
].join(" · "))
const testResult = ref<{ ok: true; agentName: string } | { ok: false; error: string } | null>(null)
const testSummary = computed(() => testResult.value && !testResult.value.ok ? testResult.value.error.trim().split(/\r?\n/u)[0]! : "")
const testHasDetails = computed(() => !!testResult.value && !testResult.value.ok && testResult.value.error.trim() !== testSummary.value)
const testDetails = ref(false)
let testRevision = 0
let finished = false

watch(template, (value, previous) => {
  if (!name.value.trim() || name.value === props.templates.find(item => item.id === previous)?.name) {
    name.value = props.templates.find(item => item.id === value)!.name
  }
})

// A custom executable or shell environment change invalidates the discovered path.
// Individual variable edits keep the last discovery until the next probe.
watch([template, binaryPath, inheritShellEnvironment], () => { resolvedBinaryPath.value = undefined }, { flush: "sync" })
// A result describes the settings it tested; any later edit makes it stale.
// Invalidate synchronously so an edit and a Test click in one tick cannot race.
watch([template, binaryPath, environment, inheritShellEnvironment], () => {
  testRevision += 1
  testing.value = false
  testResult.value = null
  testDetails.value = false
}, { deep: true, flush: "sync" })

function choose(id: AgentProviderTemplateId): void {
  if (formDisabled.value) return
  if (template.value !== id) {
    binaryPath.value = ""
    environment.value = []
    resolvedBinaryPath.value = undefined
  }
  template.value = id
  step.value = "details"
}
function back(): void {
  if (props.initial || formDisabled.value) return
  error.value = null
  step.value = "template"
}
async function editPath(): Promise<void> {
  advanced.value = true
  await nextTick()
  pathInput.value?.focus()
}

/** Validates the form and returns the provider it describes, or reports why it cannot. */
function current(): AgentProviderInput | null {
  if (!name.value.trim()) { error.value = t("providers.nameRequired"); return null }
  const keys = environment.value.map(row => row.key.trim())
  if (keys.some(key => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key))) {
    advanced.value = true
    error.value = t("providers.invalidEnvironmentKey"); return null
  }
  if (new Set(keys).size !== keys.length) { advanced.value = true; error.value = t("providers.duplicateEnvironmentKey"); return null }
  return {
    template: template.value,
    name: name.value.trim(),
    binaryPath: resolvedBinaryPath.value || binaryPath.value.trim() || undefined,
    icon: icon.value,
    inheritShellEnvironment: inheritShellEnvironment.value,
    env: Object.fromEntries(environment.value.map((row, index) => [keys[index]!, row.value])),
  }
}

async function runTest(): Promise<void> {
  if (testing.value || formDisabled.value) return
  error.value = null
  const provider = current()
  if (!provider) return
  const revision = ++testRevision
  testing.value = true
  testResult.value = null
  testDetails.value = false
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
  if (saving.value || setupBusy.value || finished) return
  finished = true
  emit("cancel")
}
async function submit(): Promise<void> {
  if (formDisabled.value) return
  error.value = null
  const provider = current()
  if (!provider) return
  saving.value = true
  try {
    await props.save(provider)
    finished = true
    emit("saved")
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { saving.value = false }
}
onBeforeUnmount(() => { finished = true })
</script>

<template>
  <UiDialog
    class="flex w-[min(72rem,calc(100vw-2rem))] flex-col"
    :class="setupExpanded ? 'h-[min(48rem,calc(100dvh-2rem))] overflow-hidden!' : 'h-[min(44rem,calc(100dvh-2rem))]'"
    :data-provider-expanded="setupExpanded ? 'true' : undefined"
    described
    :prevent-close="saving || setupBusy"
    @close="cancel"
  >
    <div class="mb-5 flex shrink-0 items-start gap-2">
      <UiButton v-if="step === 'details' && !initial" variant="ghost" size="icon" :label="t('providers.back')" :disabled="formDisabled" class="-ml-1.5 mt-[-2px]" data-provider-back @click="back"><ChevronLeft :size="16" :stroke-width="1.75" aria-hidden="true" /></UiButton>
      <div class="min-w-0">
        <DialogTitle class="ui-dialog-title">{{ t(initial ? "providers.edit" : "providers.add") }}</DialogTitle>
        <DialogDescription class="ui-dialog-description" data-provider-template>
          {{ step === "template" ? t("providers.chooseTemplate", { machine: machineName }) : t("providers.runsOn", { template: selectedTemplate.name, machine: machineName }) }}
        </DialogDescription>
      </div>
    </div>

    <div v-if="step === 'template'" class="flex min-h-0 flex-1 flex-col">
      <div role="group" :aria-label="t('providers.template')" class="min-h-0 flex-1 overflow-y-auto rounded-xl border border-ui-border">
        <button v-for="item in templates" :key="item.id" type="button" class="group flex min-h-11 w-full cursor-pointer items-center gap-2.5 border-b border-ui-border px-3 py-2 text-left ui-motion last:border-b-0 enabled:hover:bg-ui-control-hover disabled:cursor-default" :disabled="disabled" :data-provider-template-choice="item.id" @click="choose(item.id)">
          <ProviderIcon :template="item.id" :size="18" class="shrink-0" />
          <span class="min-w-0 flex-1 sm:flex sm:items-baseline sm:gap-2">
            <span class="block truncate text-sm font-medium leading-5 sm:shrink-0">{{ item.name }}</span>
            <span class="block truncate text-xs leading-4 text-ui-text-muted sm:leading-5" :title="t(`providers.templateDescription.${item.id}`)">{{ t(`providers.templateDescription.${item.id}`) }}</span>
          </span>
          <ChevronRight :size="14" :stroke-width="1.75" class="shrink-0 text-ui-text-faint group-hover:text-ui-text-muted" aria-hidden="true" />
        </button>
      </div>
      <div class="ui-dialog-actions mt-4">
        <UiButton type="button" @click="cancel">{{ t("catalog.cancel") }}</UiButton>
      </div>
    </div>

    <form v-else class="flex flex-1 flex-col gap-5" :class="setupExpanded && 'min-h-0'" @submit.prevent="submit">
      <div v-if="!setupExpanded" class="flex flex-col gap-1.5 text-sm">
        <label for="provider-name">{{ t("providers.name") }}</label>
        <div class="flex items-stretch gap-2">
          <ProviderIconPicker v-model="icon" :template="template" :disabled="formDisabled" />
          <input id="provider-name" v-model="name" name="provider-name" class="ui-input" autofocus required maxlength="256" :disabled="formDisabled" autocomplete="off" />
        </div>
      </div>

      <ProviderSetup
        :provider="setupProvider" :machine-name="machineName" :disabled="saving || testing || disabled" :fill="setupExpanded"
        :probe="probe" :install="install" :login="login"
        @active="setupExpanded = $event" @busy="setupBusy = $event" @resolved="resolvedBinaryPath = $event" @binary-path="binaryPath = $event" @edit-path="editPath"
      />

      <CollapsibleRoot v-if="!setupExpanded" v-model:open="advanced" :unmount-on-hide="false" class="text-sm" data-provider-advanced>
        <CollapsibleTrigger class="flex w-fit cursor-pointer items-center gap-1.5 rounded-md outline-offset-2 text-[13px] text-ui-text-muted hover:text-ui-text">
          <ChevronRight :size="14" :stroke-width="1.75" class="ui-motion" :class="advanced && 'rotate-90'" aria-hidden="true" />
          {{ t("providers.advanced") }}
          <span v-if="!advanced && advancedSummary" class="text-ui-text-faint">· {{ advancedSummary }}</span>
        </CollapsibleTrigger>
        <CollapsibleContent class="mt-4 flex flex-col gap-5">
          <label class="flex flex-col gap-1.5">
            {{ t("providers.binaryPath") }}
            <input ref="pathInput" v-model="binaryPath" name="provider-binary" class="ui-input font-mono text-[13px]" :placeholder="resolvedBinaryPath ?? selectedTemplate.defaultBinaryPath" :disabled="formDisabled" autocomplete="off" :spellcheck="false" />
            <span class="text-xs text-ui-text-muted">{{ resolvedBinaryPath ? t("providers.binaryDetected") : t("providers.binaryDefault", { binary: selectedTemplate.defaultBinaryPath }) }}</span>
          </label>
          <div class="flex items-start justify-between gap-4">
            <div class="flex flex-col gap-1">
              <label id="provider-shell-environment-label" for="provider-shell-environment">{{ t("providers.shellEnvironment") }}</label>
              <p id="provider-shell-environment-description" class="m-0 text-xs text-ui-text-muted">{{ t("providers.shellEnvironmentDescription") }}</p>
            </div>
            <UiSwitch id="provider-shell-environment" v-model="inheritShellEnvironment" :disabled="formDisabled" aria-labelledby="provider-shell-environment-label" aria-describedby="provider-shell-environment-description" data-provider-shell-environment />
          </div>
          <fieldset class="m-0 min-w-0 border-0 p-0" :disabled="formDisabled">
            <legend class="mb-1">{{ t("providers.environment") }}</legend>
            <p class="m-0 mb-2.5 text-xs text-ui-text-muted">{{ t("providers.environmentDescription") }}</p>
            <div class="flex flex-col gap-2">
              <div v-for="(row, index) in environment" :key="row.id" class="flex items-center gap-2" data-environment-row>
                <input v-model="row.key" class="ui-input min-w-0 flex-1 font-mono text-xs" :aria-label="t('providers.environmentKey', { n: index + 1 })" :placeholder="t('providers.key')" autocomplete="off" :spellcheck="false" />
                <input v-model="row.value" class="ui-input min-w-0 flex-[1.4] font-mono text-xs" :aria-label="t('providers.environmentValue', { n: index + 1 })" :placeholder="t('providers.value')" autocomplete="off" :spellcheck="false" />
                <UiButton variant="ghost" size="icon" :label="t('providers.removeEnvironment', { n: index + 1 })" :disabled="formDisabled" @click="environment.splice(index, 1)"><Trash2 :size="16" :stroke-width="1.75" aria-hidden="true" /></UiButton>
              </div>
              <UiButton variant="ghost" size="sm" type="button" class="-ml-2 w-fit cursor-pointer hover:bg-ui-hover" @click="environment.push({ id: nextRowId++, key: '', value: '' })">
                <Plus :size="14" :stroke-width="1.75" aria-hidden="true" />{{ t("providers.addEnvironment") }}
              </UiButton>
            </div>
          </fieldset>
        </CollapsibleContent>
      </CollapsibleRoot>

      <p v-if="error" role="alert" class="m-0 text-sm text-ui-danger">{{ error }}</p>
      <template v-if="!setupExpanded">
        <p v-if="testing" role="status" class="ui-notice m-0 border-ui-border text-ui-text-muted" data-provider-test-result>
          <LoaderCircle :size="15" :stroke-width="2" class="shrink-0 animate-spin" aria-hidden="true" />{{ t("providers.testing") }}
        </p>
        <p v-else-if="testResult?.ok" role="status" class="ui-notice m-0 border-ui-success/30 bg-ui-success/8" data-provider-test-result>
          <CircleCheck :size="15" :stroke-width="2" class="shrink-0 text-ui-success" aria-hidden="true" />{{ t("providers.testSucceeded", { agent: testResult.agentName }) }}
        </p>
        <div v-else-if="testResult" role="alert" class="flex flex-col gap-2 rounded-xl border border-ui-danger/30 bg-ui-danger/8 px-3 py-2 text-[13px]" data-provider-test-result>
          <div class="flex min-h-6 items-center gap-2">
            <CircleX :size="15" :stroke-width="2" class="shrink-0 text-ui-danger" aria-hidden="true" />
            <span class="min-w-0 flex-1 break-words" data-provider-test-summary>{{ t("providers.testFailed", { error: testSummary }) }}</span>
            <UiButton variant="ghost" size="sm" v-if="testHasDetails" type="button" class="shrink-0 cursor-pointer hover:bg-ui-hover" :aria-expanded="testDetails" data-provider-test-details-toggle @click="testDetails = !testDetails">{{ t(testDetails ? "providers.hideDetails" : "providers.showDetails") }}</UiButton>
          </div>
          <pre v-if="testDetails" class="m-0 max-h-48 overflow-auto rounded-lg bg-ui-canvas/60 p-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-ui-text-muted select-text" data-provider-test-details>{{ testResult.error.trim() }}</pre>
        </div>
      </template>

      <div v-if="!setupExpanded" class="mt-auto flex shrink-0 flex-wrap justify-end gap-2">
        <UiButton type="button" class="mr-auto" :title="t('providers.testDescription')" :disabled="testing || formDisabled" data-provider-test @click="runTest">{{ testing ? t("providers.testing") : t("providers.test") }}</UiButton>
        <UiButton type="button" :disabled="saving || setupBusy" @click="cancel">{{ t("catalog.cancel") }}</UiButton>
        <UiButton variant="primary" type="submit" :loading="saving" :disabled="formDisabled">{{ saving ? t("catalog.saving") : t(initial ? "catalog.save" : "providers.add") }}</UiButton>
      </div>
    </form>
  </UiDialog>
</template>
