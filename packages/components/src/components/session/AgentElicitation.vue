<script setup lang="ts">
import { CircleHelp } from "@lucide/vue"
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { AgentElicitation } from "../../../../../apps/daemon/src/agent-protocol.ts"
import { validateElicitationResponse } from "../../../../../apps/daemon/src/agent-elicitation-protocol.ts"
import { elicitationContent, elicitationDefaults, elicitationForm, elicitationInputType, type ElicitationField, type ElicitationValue } from "../../services/agent-elicitation.ts"
import { useAgentSessionsStore } from "../../stores/agent-sessions.ts"
import AgentActor from "./AgentActor.vue"

const props = defineProps<{ elicitation: AgentElicitation; disabled?: boolean }>()
const { t } = useI18n()
const agents = useAgentSessionsStore()
const form = computed(() => elicitationForm(props.elicitation.request))
const pending = computed(() => props.elicitation.state === "pending")
const operation = computed(() => Object.values(agents.operations).find(operation => operation.sessionId === props.elicitation.sessionId && operation.method === "_deskfleet/elicitation/respond" && operation.params.elicitationId === props.elicitation.id))
const disabled = computed(() => props.disabled || !pending.value || !!operation.value)
const supported = computed(() => !!form.value && form.value.fields.every(field => ["string", "boolean", "number", "integer", "array"].includes(field.type)))
const draft = computed(() => agents.elicitationDrafts[props.elicitation.id] ?? {})
const formElement = ref<HTMLFormElement | null>(null)
const invalid = ref(false)
const failed = ref(false)
watch(() => [props.elicitation.id, props.elicitation.state], () => {
  invalid.value = false
  failed.value = false
  if (pending.value) agents.elicitationDrafts[props.elicitation.id] ??= elicitationDefaults(form.value?.fields ?? [])
  else delete agents.elicitationDrafts[props.elicitation.id]
}, { immediate: true })

function setValue(id: string, value: ElicitationValue): void {
  if (disabled.value) return
  agents.elicitationDrafts[props.elicitation.id]![id] = value
  invalid.value = false
}
function clearValue(id: string): void {
  if (!disabled.value) delete agents.elicitationDrafts[props.elicitation.id]![id]
}
function selectMany(id: string, value: string, checked: boolean): void {
  const current = draft.value[id]
  const selected = Array.isArray(current) ? current : []
  setValue(id, checked ? [...selected, value] : selected.filter(item => item !== value))
}
function selected(id: string, value: string): boolean {
  const current = draft.value[id]
  return Array.isArray(current) && current.includes(value)
}
async function respond(action: "accept" | "decline" | "cancel"): Promise<void> {
  if (disabled.value) return
  failed.value = false
  let response: NonNullable<AgentElicitation["response"]> = { action }
  if (action === "accept") {
    if (!supported.value) return
    try {
      response = validateElicitationResponse(props.elicitation.request, { action, content: elicitationContent(form.value!.fields, draft.value) })
    } catch {
      invalid.value = true
      formElement.value?.reportValidity()
      return
    }
  }
  try { await agents.respondToElicitation(props.elicitation.sessionId, props.elicitation.id, response) }
  catch { failed.value = true }
}
const status = computed(() => props.elicitation.state === "cancelled" || props.elicitation.response?.action === "cancel" ? "cancelled" : props.elicitation.response?.action === "decline" ? "declined" : "answered")
const answers = computed(() => {
  const response = props.elicitation.response
  if (response?.action !== "accept" || !response.content || typeof response.content !== "object") return []
  const content = response.content as Record<string, unknown>
  return (form.value?.fields ?? []).filter(field => !field.secret && field.id in content).map(field => ({ id: field.id, title: field.title, text: displayAnswer(field, content[field.id]) }))
})
function displayAnswer(field: ElicitationField, value: unknown): string {
  if (typeof value === "boolean") return t(value ? "agent.questions.yes" : "agent.questions.no")
  const label = (item: unknown) => field.choices.find(choice => choice.value === item)?.title ?? String(item)
  return Array.isArray(value) ? value.map(label).join(", ") : label(value)
}
</script>

<template>
  <section class="rounded-xl border border-ui-border bg-ui-surface p-4 text-sm shadow-ui-card" data-testid="agent-elicitation" :data-elicitation-id="elicitation.id" :aria-label="t('agent.questions.title')">
    <p class="m-0 mb-2 flex items-center gap-2 font-medium"><CircleHelp :size="16" :stroke-width="1.75" class="shrink-0 text-ui-text-muted" aria-hidden="true" /><span>{{ t(pending ? 'agent.questions.title' : `agent.questions.${status}`) }}<template v-if="!pending && elicitation.actor"> · <AgentActor :actor="elicitation.actor" /></template></span></p>
    <p class="m-0 whitespace-pre-wrap break-words">{{ elicitation.request.message }}</p>
    <form v-if="pending" ref="formElement" class="mt-4 flex flex-col gap-4" @submit.prevent="respond('accept')">
      <template v-if="form">
        <p v-if="form.title" class="m-0 font-medium">{{ form.title }}</p>
        <p v-if="form.description" class="m-0 text-ui-text-muted">{{ form.description }}</p>
        <fieldset v-for="field in form.fields" :key="field.id" :disabled="disabled" class="m-0 min-w-0 border-0 p-0">
          <legend class="mb-1 max-w-full break-words p-0 font-medium">{{ field.title }} <span class="text-xs font-normal text-ui-text-muted">{{ t(field.required ? 'agent.questions.required' : 'agent.questions.optional') }}</span></legend>
          <p v-if="field.description" class="m-0 mb-2 whitespace-pre-wrap text-ui-text-muted">{{ field.description }}</p>
          <div v-if="field.type === 'boolean'" class="flex flex-wrap gap-3">
            <label v-for="value in [true, false]" :key="String(value)" class="inline-flex cursor-pointer items-center gap-2">
              <input type="radio" :name="field.id" :value="String(value)" :checked="draft[field.id] === value" :required="field.required" @change="setValue(field.id, value)" />{{ t(value ? 'agent.questions.yes' : 'agent.questions.no') }}
            </label>
          </div>
          <div v-else-if="field.choices.length && !field.secret" class="flex flex-col gap-2">
            <label v-for="choice in field.choices" :key="choice.value" class="flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2" :class="(field.type === 'array' ? selected(field.id, choice.value) : draft[field.id] === choice.value) ? 'border-ui-accent bg-ui-accent/6' : 'border-ui-border hover:border-ui-border-strong'">
              <input :type="field.type === 'array' ? 'checkbox' : 'radio'" :name="field.id" :value="choice.value" :checked="field.type === 'array' ? selected(field.id, choice.value) : draft[field.id] === choice.value" :required="field.type !== 'array' && field.required" class="mt-1 shrink-0" @change="field.type === 'array' ? selectMany(field.id, choice.value, ($event.target as HTMLInputElement).checked) : setValue(field.id, choice.value)" />
              <span class="min-w-0"><span class="block break-words">{{ choice.title }}</span><span v-if="choice.description" class="mt-0.5 block whitespace-pre-wrap text-xs text-ui-text-muted">{{ choice.description }}</span></span>
            </label>
          </div>
          <input v-else-if="['string', 'number', 'integer'].includes(field.type)" :type="elicitationInputType(field)" :name="field.id" :aria-label="field.title" :value="draft[field.id] ?? ''" :required="field.required" :min="field.minimum" :max="field.maximum" :minlength="field.minLength" :maxlength="field.maxLength" :pattern="field.pattern" :step="field.type === 'integer' ? 1 : 'any'" :autocomplete="field.secret ? 'off' : undefined" class="ui-input text-sm" @input="setValue(field.id, ($event.target as HTMLInputElement).value)" />
          <p v-else class="m-0 text-ui-text-muted">{{ t('agent.questions.unsupported') }}</p>
          <button v-if="!field.required && draft[field.id] !== undefined" type="button" class="mt-1 cursor-pointer text-xs text-ui-text-muted hover:text-ui-text disabled:cursor-default" @click="clearValue(field.id)">{{ t('agent.questions.clear') }}</button>
        </fieldset>
      </template>
      <p v-if="!supported" class="m-0 text-ui-text-muted">{{ t('agent.questions.unsupported') }}</p>
      <p v-if="invalid" role="alert" class="m-0 text-ui-danger">{{ t('agent.questions.invalid') }}</p>
      <p v-if="failed || operation?.error" role="alert" class="m-0 text-ui-warning">{{ t('agent.operationPending') }}</p>
      <div class="flex flex-wrap justify-end gap-2">
        <button type="button" data-testid="elicitation-cancel" class="ui-button" :disabled="disabled" @click="respond('cancel')">{{ t('agent.questions.cancel') }}</button>
        <button type="button" data-testid="elicitation-decline" class="ui-button" :disabled="disabled" @click="respond('decline')">{{ t('agent.questions.decline') }}</button>
        <button type="submit" data-testid="elicitation-submit" class="ui-button-primary" :disabled="disabled || !supported">{{ t(operation ? 'agent.questions.sending' : 'agent.questions.submit') }}</button>
      </div>
    </form>
    <dl v-else-if="answers.length" class="m-0 mt-3 flex flex-col gap-2">
      <div v-for="answer in answers" :key="answer.id"><dt class="text-xs text-ui-text-muted">{{ answer.title }}</dt><dd class="m-0 whitespace-pre-wrap break-words">{{ answer.text }}</dd></div>
    </dl>
  </section>
</template>
