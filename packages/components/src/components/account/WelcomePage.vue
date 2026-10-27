<script setup lang="ts">
import UiButton from "../common/UiButton.vue"
import { Check, ChevronRight, FolderOpen, KeyRound, Monitor, MousePointer2, ShieldCheck } from "@lucide/vue"
import { useEventListener, whenever } from "@vueuse/core"
import { computed, onBeforeUnmount, ref } from "vue"
import { useI18n } from "vue-i18n"
import type { DeskfleetDesktopApi } from "@deskfleet/client/desktop-api"
import type { DesktopPermissionsState } from "@deskfleet/client/local-agent"
import { ONBOARDING_PERMISSIONS, onboardingPermissions, type OnboardingPermission, type OnboardingState, type OnboardingStep } from "@deskfleet/client/onboarding"
import { useAccountSession } from "../../composables/useAccountSession.ts"
import BrandLogo from "../common/BrandLogo.vue"

const props = defineProps<{ host: DeskfleetDesktopApi; state: OnboardingState }>()
const emit = defineEmits<{ change: [state: OnboardingState] }>()
const { t } = useI18n()
const session = useAccountSession()!
const onboarding = props.host.onboarding
const firstRun = props.state.step !== "complete"
const step = ref<OnboardingStep>(firstRun ? props.state.step : "account")
const pending = ref(false)
const refreshing = ref(false)
const error = ref(session.notice.value)
const permissions = ref<Partial<DesktopPermissionsState>>({})
// Permission events can arrive before an older IPC snapshot resolves.
let permissionRevision = 0
const linux = computed(() => props.host.platform === "linux")
const permissionSteps = computed(() => onboardingPermissions(props.host.platform))
const permission = computed(() => permissionSteps.value.find(value => value === step.value))
const currentPermission = computed(() => permission.value ? permissions.value[`${permission.value}Permission`] : undefined)
const granted = computed(() => ["granted", "not-required"].includes(currentPermission.value?.status ?? ""))
const requesting = computed(() => currentPermission.value?.status === "requesting" || linux.value
  && permissionSteps.value.some(kind => permissions.value[`${kind}Permission`]?.status === "requesting"))
const canRequest = computed(() => !granted.value && !requesting.value && (!linux.value
  || !refreshing.value && currentPermission.value?.status !== "checking"))
const permissionMessages = computed(() => `welcome.${linux.value ? "wayland" : "permissions"}.${permission.value}`)
const steps = computed<OnboardingStep[]>(() => [...(firstRun ? permissionSteps.value : []), "account"])
const icons = { fullDiskAccess: FolderOpen, screenCapture: Monitor, accessibility: MousePointer2, account: KeyRound, complete: Check }
const currentIndex = computed(() => steps.value.indexOf(step.value))
const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason)
const stepLabel = (value: OnboardingStep) => t(linux.value && (value === "screenCapture" || value === "accessibility")
  ? `welcome.wayland.${value}.title` : `welcome.steps.${value}`)

function move(next: OnboardingState): void {
  step.value = next.step
  error.value = undefined
  emit("change", next)
}

async function act(work: () => Promise<void>): Promise<void> {
  if (pending.value) return
  pending.value = true
  error.value = undefined
  try { await work() }
  catch (reason) { error.value = message(reason) }
  finally { pending.value = false }
}

async function submit(): Promise<void> {
  await act(async () => {
    session.notice.value = undefined
    if (!session.account.value.user) await session.signIn()
    move(firstRun && onboarding ? await onboarding.complete() : { step: "complete" })
  })
}

async function refreshPermissions(): Promise<void> {
  if (!onboarding || !permission.value || refreshing.value) return
  refreshing.value = true
  const requestedStep = step.value
  const revision = permissionRevision
  try {
    const value = await onboarding.permissions()
    if (revision === permissionRevision) permissions.value = value
    if (step.value === requestedStep) error.value = undefined
  } catch (reason) {
    if (step.value === requestedStep) error.value = message(reason)
  } finally { refreshing.value = false }
}

async function requestPermission(kind: OnboardingPermission): Promise<void> {
  if (!canRequest.value) return
  await act(async () => {
    const revision = ++permissionRevision
    const value = await onboarding!.requestPermission(kind)
    if (revision === permissionRevision) permissions.value = value
  })
}

async function advancePermission(kind: OnboardingPermission): Promise<void> {
  await act(async () => { move(await onboarding!.advancePermission(kind)) })
}

whenever(permission, () => { void refreshPermissions() }, { immediate: true })
const unsubscribe = onboarding ? props.host.settings.onChanged(state => {
  if (!ONBOARDING_PERMISSIONS.some(kind => state[`${kind}Permission`])) return
  ++permissionRevision
  for (const kind of ONBOARDING_PERMISSIONS) {
    const value = state[`${kind}Permission`]
    if (value) permissions.value[`${kind}Permission`] = value
  }
}) : undefined
useEventListener(window, "focus", refreshPermissions)
onBeforeUnmount(() => { unsubscribe?.() })
</script>

<template>
  <div class="app-drag titlebar-overlay-inset flex h-12 shrink-0 items-center gap-2 px-5 text-[13px] font-medium" :class="host.platform === 'darwin' && 'pl-20'">
    <BrandLogo :size="24" decorative />{{ session.site.value?.siteName ?? 'deskfleet' }}
  </div>
  <main class="flex min-h-0 flex-1 justify-center overflow-y-auto p-5 sm:p-8">
    <div class="ui-card my-auto grid w-full max-w-4xl overflow-hidden shadow-ui-card md:grid-cols-[0.9fr_1.1fr]">
      <aside class="flex flex-col gap-6 border-b border-ui-border bg-ui-sidebar p-7 md:border-b-0 md:border-r md:p-9">
        <div>
          <BrandLogo :size="52" class="mb-5" />
          <p class="m-0 text-2xl font-semibold tracking-tight">{{ t("welcome.title") }}</p>
          <p class="m-0 mt-3 max-w-xs text-sm leading-relaxed text-ui-text-muted">{{ t(firstRun ? "welcome.description" : "account.signInDescription") }}</p>
        </div>
        <ol class="m-0 flex list-none flex-wrap gap-3 p-0 md:flex-col md:gap-4" :aria-label="t('welcome.progress')">
          <li v-for="(item, index) in steps" :key="item" class="flex items-center gap-3 text-sm" :aria-current="item === step ? 'step' : undefined" :class="item === step ? 'font-medium text-ui-text' : 'text-ui-text-muted'">
            <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-ui-border" :class="item === step && 'bg-ui-canvas shadow-sm'">
              <Check v-if="index < currentIndex" :size="15" aria-hidden="true" />
              <component :is="icons[item]" v-else :size="15" aria-hidden="true" />
            </span>
            {{ stepLabel(item) }}
          </li>
        </ol>
      </aside>
      <section class="flex min-w-0 flex-col justify-center p-7 md:min-h-110 md:p-9">
        <template v-if="permission">
          <ShieldCheck :size="30" :stroke-width="1.5" class="mb-5 text-ui-text-muted" aria-hidden="true" />
          <p class="m-0 mb-2 text-xs text-ui-text-muted">{{ t("welcome.stepCount", { current: currentIndex + 1, total: steps.length }) }}</p>
          <h1 class="m-0 text-xl font-semibold">{{ stepLabel(permission) }}</h1>
          <p class="m-0 mt-3 text-sm leading-relaxed text-ui-text-muted">{{ t(`${permissionMessages}.description`) }}</p>
          <div class="my-6 rounded-lg border border-ui-border bg-ui-sidebar p-4">
            <p class="m-0 text-xs font-medium">{{ t(linux ? "welcome.wayland.dialog" : "welcome.systemSettings") }}</p>
            <p class="m-0 mt-2 text-sm leading-relaxed text-ui-text-muted">{{ t(`${permissionMessages}.${linux ? 'instructions' : 'path'}`) }}</p>
            <p class="m-0 mt-3 text-xs leading-relaxed text-ui-text-muted">{{ t(linux ? "welcome.wayland.shared" : "welcome.permissionRestart") }}</p>
          </div>
          <p role="status" class="m-0 mb-4 text-sm" :class="granted ? 'text-ui-text' : 'text-ui-text-muted'">
            {{ t(linux && requesting ? 'welcome.wayland.requesting' : `welcome.permissionStatus.${currentPermission?.status ?? 'checking'}`) }}
          </p>
          <p v-if="error || currentPermission?.error" role="alert" class="m-0 mb-4 break-words text-sm text-ui-danger">{{ error || currentPermission?.error }}</p>
          <div class="flex flex-wrap gap-2">
            <UiButton variant="primary" v-if="!granted" type="button" :disabled="pending || !canRequest" @click="requestPermission(permission)">{{ t(linux ? "welcome.wayland.retry" : "welcome.openSettings") }}</UiButton>
            <UiButton type="button" :disabled="pending || refreshing" @click="refreshPermissions">{{ t(refreshing ? "welcome.checking" : "welcome.checkAgain") }}</UiButton>
            <UiButton variant="primary" v-if="granted" type="button" class="ml-auto" :disabled="pending" @click="advancePermission(permission)">{{ t("welcome.continue") }}<ChevronRight :size="15" aria-hidden="true" /></UiButton>
          </div>
          <template v-if="!granted">
            <p class="m-0 mt-5 text-xs leading-relaxed text-ui-text-muted">{{ t(`${permissionMessages}.skip`) }}</p>
            <button type="button" class="mt-3 w-fit cursor-pointer border-0 bg-transparent p-0 text-sm text-ui-text-muted underline underline-offset-4 disabled:cursor-default disabled:opacity-50" :disabled="pending || requesting" @click="advancePermission(permission)">{{ t("welcome.skip") }}</button>
          </template>
        </template>
        <form v-else class="flex flex-col gap-5" @submit.prevent="submit">
          <div>
            <h1 class="m-0 text-xl font-semibold">{{ t("account.signIn") }}</h1>
            <p class="m-0 mt-3 text-sm leading-relaxed text-ui-text-muted">{{ t("account.signInDescription") }}</p>
          </div>
          <p v-if="error" role="alert" class="m-0 break-words text-sm text-ui-danger">{{ error }}</p>
          <UiButton variant="primary" class="min-h-9 text-sm" type="submit" :disabled="pending">
            {{ session.account.value.user ? t("welcome.continueAs", { name: session.account.value.user.name }) : t(pending ? "account.signingIn" : "account.continueSignIn") }}
          </UiButton>
        </form>
      </section>
    </div>
  </main>
</template>
