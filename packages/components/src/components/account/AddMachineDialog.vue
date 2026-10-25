<script setup lang="ts">
import { ChevronRight, Laptop, Server } from "@lucide/vue"
import { whenever } from "@vueuse/core"
import { computed, nextTick, onMounted, ref, useId, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import CopyField from "../common/CopyField.vue"
import { parseDaemonStatus } from "./daemon-status.ts"

const emit = defineEmits<{ close: [] }>()
const { t } = useI18n()
const id = useId()
const session = useAccountSession()!
const dialog = useTemplateRef<HTMLDialogElement>("dialog")
const statusInput = useTemplateRef<HTMLTextAreaElement>("statusInput")
const localName = useTemplateRef<HTMLInputElement>("localName")
const credentialField = useTemplateRef<InstanceType<typeof CopyField>>("credentialField")
// The desktop can register the daemon it hosts; every client can register another machine.
const step = ref<"choose" | "local" | "headless" | "credentials">(session.central.enrollLocal ? "choose" : "headless")
const statusText = ref("")
const name = ref("")
// Once the user types a name, a newly parsed status no longer overwrites it.
const nameEdited = ref(false)
const pending = ref(false)
const error = ref<string>()
const credentials = ref("")
const team = computed(() => session.team.value)
const parsed = computed(() => statusText.value.trim() ? parseDaemonStatus(statusText.value.trim()) : undefined)
const identity = computed(() => parsed.value?.ok ? parsed.value : undefined)
const enrollCommand = computed(() => `deskfleet-daemon enroll --server-url ${session.account.value.serverUrl}`)

const local = computed(() => session.enrollment.value)
// A computer that already belongs to a Team is never silently reassigned.
const localTeam = computed(() => {
  if (!local.value?.configured || local.value.revoked) return undefined
  if (local.value.serverUrl !== session.account.value.serverUrl) return local.value.serverUrl ?? ""
  return session.teams.value.find(value => value.id === local.value!.teamId)?.name ?? local.value.serverUrl ?? ""
})

whenever(identity, value => { if (!nameEdited.value) name.value = value.name })

function close(): void { if (!pending.value) emit("close") }
async function run(work: () => Promise<void>): Promise<void> {
  if (pending.value) return
  pending.value = true
  error.value = undefined
  try { await work() } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { pending.value = false }
}
// Each path starts from its machine's hostname, which the user can replace.
async function chooseLocal(): Promise<void> {
  step.value = "local"
  error.value = undefined
  name.value = local.value?.machineName ?? ""
  await nextTick()
  localName.value?.focus()
  localName.value?.select()
}
const connectThisComputer = () => run(async () => {
  await session.enrollLocal(name.value.trim())
  emit("close")
})
async function chooseHeadless(): Promise<void> {
  step.value = "headless"
  error.value = undefined
  name.value = identity.value?.name ?? ""
  nameEdited.value = false
  await nextTick()
  statusInput.value?.focus()
}
const register = () => run(async () => {
  if (!identity.value) return
  const teamId = session.teamId.value
  const result = await session.enrollHeadless({ name: name.value.trim(), originId: identity.value.originId, localMachineId: identity.value.localMachineId })
  credentials.value = JSON.stringify({ machineId: result.machine.id, teamId, token: result.token }, null, 2)
  step.value = "credentials"
  await nextTick()
  credentialField.value?.focus()
})
onMounted(() => { dialog.value?.showModal(); if (step.value === "headless") statusInput.value?.focus() })
</script>

<template>
  <dialog ref="dialog" class="ui-dialog app-no-drag w-[34rem] max-h-[90vh] overflow-y-auto" :aria-labelledby="`${id}-title`" :aria-describedby="`${id}-description`" @cancel.prevent="close">
    <h2 :id="`${id}-title`" class="ui-dialog-title">{{ t(step === "credentials" ? "addMachine.finishTitle" : "addMachine.title", { team: team?.name ?? "" }) }}</h2>
    <p :id="`${id}-description`" class="ui-dialog-description mb-5">{{ t(step === "credentials" ? "addMachine.finishDescription" : "addMachine.description") }}</p>

    <div v-if="step === 'choose'" class="flex flex-col gap-2">
      <button type="button" class="ui-option-card" :disabled="pending || !session.canEnrollLocal.value" data-add-machine="local" @click="chooseLocal">
        <Laptop :size="20" :stroke-width="1.75" class="shrink-0 text-ui-accent" aria-hidden="true" />
        <span class="min-w-0 flex-1">
          <span class="block text-sm">{{ t("account.thisComputer") }}<span v-if="local" class="text-ui-text-muted"> · {{ local.machineName }}</span></span>
          <span class="mt-0.5 block text-[13px] text-ui-text-muted">
            {{ localTeam !== undefined ? t("addMachine.localConnected", { team: localTeam }) : local?.revoked ? t("addMachine.localRevoked") : t("addMachine.localDescription") }}
          </span>
        </span>
        <ChevronRight v-if="session.canEnrollLocal.value" :size="16" class="shrink-0 text-ui-text-faint" aria-hidden="true" />
      </button>
      <button type="button" class="ui-option-card" :disabled="pending" data-add-machine="headless" @click="chooseHeadless">
        <Server :size="20" :stroke-width="1.75" class="shrink-0 text-ui-accent" aria-hidden="true" />
        <span class="min-w-0 flex-1">
          <span class="block text-sm">{{ t("addMachine.other") }}</span>
          <span class="mt-0.5 block text-[13px] text-ui-text-muted">{{ t("addMachine.otherDescription") }}</span>
        </span>
        <ChevronRight :size="16" class="shrink-0 text-ui-text-faint" aria-hidden="true" />
      </button>
      <p v-if="error" role="alert" class="m-0 mt-2 text-sm text-ui-danger">{{ error }}</p>
      <div class="ui-dialog-actions mt-4"><button type="button" class="ui-button" :disabled="pending" @click="close">{{ t("catalog.cancel") }}</button></div>
    </div>

    <form v-else-if="step === 'local'" class="flex flex-col gap-5" @submit.prevent="connectThisComputer">
      <label class="flex flex-col gap-1.5 text-[13px] text-ui-text-muted">
        {{ t("addMachine.nameStep") }}
        <input ref="localName" v-model="name" name="machine-name" class="ui-input text-sm text-ui-text" required maxlength="200" autocomplete="off" :disabled="pending" :aria-describedby="`${id}-local-name`" />
        <span :id="`${id}-local-name`" class="text-xs">{{ t("addMachine.nameHint") }}</span>
      </label>
      <p v-if="error" role="alert" class="m-0 text-sm text-ui-danger">{{ error }}</p>
      <div class="flex justify-end gap-2">
        <button type="button" class="ui-button mr-auto" :disabled="pending" @click="step = 'choose'; error = undefined">{{ t("addMachine.back") }}</button>
        <button type="button" class="ui-button" :disabled="pending" @click="close">{{ t("catalog.cancel") }}</button>
        <button type="submit" class="ui-button-primary" :disabled="pending || !name.trim()">{{ pending ? t("addMachine.connecting") : t("addMachine.connect") }}</button>
      </div>
    </form>

    <form v-else-if="step === 'headless'" class="flex flex-col gap-5" @submit.prevent="register">
      <ol class="m-0 flex list-none flex-col gap-5 p-0">
        <li class="flex gap-3">
          <span class="mt-px flex h-5.5 w-5.5 shrink-0 items-center justify-center rounded-full bg-ui-accent/12 text-xs font-semibold text-ui-accent" aria-hidden="true">1</span>
          <div class="min-w-0 flex-1"><CopyField :label="t('addMachine.statusStep')" value="deskfleet-daemon status" /></div>
        </li>
        <li class="flex gap-3">
          <span class="mt-px flex h-5.5 w-5.5 shrink-0 items-center justify-center rounded-full bg-ui-accent/12 text-xs font-semibold text-ui-accent" aria-hidden="true">2</span>
          <div class="flex min-w-0 flex-1 flex-col gap-1.5">
            <label :for="`${id}-status`" class="text-[13px] text-ui-text-muted">{{ t("addMachine.pasteStep") }}</label>
            <textarea :id="`${id}-status`" ref="statusInput" v-model="statusText" name="daemon-status" class="ui-input h-28 resize-none font-mono text-xs" :disabled="pending" :spellcheck="false" :aria-describedby="`${id}-status-result`" :aria-invalid="parsed && !parsed.ok" />
            <p :id="`${id}-status-result`" class="m-0 text-xs" :class="parsed && !parsed.ok ? 'text-ui-danger' : 'text-ui-text-muted'">
              <template v-if="!parsed">{{ t("addMachine.pasteHint") }}</template>
              <template v-else-if="!parsed.ok">{{ t(`addMachine.status.${parsed.reason}`) }}</template>
              <template v-else>{{ t("addMachine.identityFound") }}</template>
            </p>
          </div>
        </li>
        <li class="flex gap-3">
          <span class="mt-px flex h-5.5 w-5.5 shrink-0 items-center justify-center rounded-full bg-ui-accent/12 text-xs font-semibold text-ui-accent" aria-hidden="true">3</span>
          <label class="flex min-w-0 flex-1 flex-col gap-1.5 text-[13px] text-ui-text-muted">
            {{ t("addMachine.nameStep") }}
            <input v-model="name" name="machine-name" class="ui-input text-sm text-ui-text" required maxlength="200" autocomplete="off" :disabled="pending || !identity" :aria-describedby="`${id}-headless-name`" @input="nameEdited = true" />
            <span :id="`${id}-headless-name`" class="text-xs">{{ t("addMachine.nameHint") }}</span>
          </label>
        </li>
      </ol>
      <p v-if="error" role="alert" class="m-0 text-sm text-ui-danger">{{ error }}</p>
      <div class="flex justify-end gap-2">
        <button v-if="session.central.enrollLocal" type="button" class="ui-button mr-auto" :disabled="pending" @click="step = 'choose'; error = undefined">{{ t("addMachine.back") }}</button>
        <button type="button" class="ui-button" :disabled="pending" @click="close">{{ t("catalog.cancel") }}</button>
        <button type="submit" class="ui-button-primary" :disabled="pending || !identity || !name.trim()">{{ pending ? t("addMachine.adding") : t("account.addMachine") }}</button>
      </div>
    </form>

    <div v-else class="flex flex-col gap-5">
      <ol class="m-0 flex list-none flex-col gap-5 p-0">
        <li class="flex gap-3">
          <span class="mt-px flex h-5.5 w-5.5 shrink-0 items-center justify-center rounded-full bg-ui-accent/12 text-xs font-semibold text-ui-accent" aria-hidden="true">1</span>
          <div class="min-w-0 flex-1"><CopyField :label="t('addMachine.enrollStep')" :value="enrollCommand" /></div>
        </li>
        <li class="flex gap-3">
          <span class="mt-px flex h-5.5 w-5.5 shrink-0 items-center justify-center rounded-full bg-ui-accent/12 text-xs font-semibold text-ui-accent" aria-hidden="true">2</span>
          <div class="min-w-0 flex-1"><CopyField ref="credentialField" :label="t('addMachine.credentialsStep')" :value="credentials" multiline /></div>
        </li>
      </ol>
      <p class="m-0 rounded-xl border border-ui-warning/30 bg-ui-warning/8 px-3 py-2 text-[13px] text-ui-warning">{{ t("addMachine.credentialsWarning") }}</p>
      <div class="flex justify-end"><button type="button" class="ui-button-primary" @click="close">{{ t("account.done") }}</button></div>
    </div>
  </dialog>
</template>

