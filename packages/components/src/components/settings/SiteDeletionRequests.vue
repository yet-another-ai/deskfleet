<script setup lang="ts">
import { useI18n } from "vue-i18n"
import { computed, ref } from "vue"
import { intlLocale, type AppLocale } from "@deskfleet/client/i18n"
import type { AdminAccountDeletionRequest } from "@deskfleet/client/account-deletion"
import type { SiteAdministrationApi } from "@deskfleet/client/central"
import { failureMessage, type RecentAuthentication } from "../../composables/useRecentAuthentication.ts"
import ConfirmDialog from "../common/ConfirmDialog.vue"
import UiButton from "../common/UiButton.vue"

const props = defineProps<{ api: SiteAdministrationApi; confirmed: RecentAuthentication["confirmed"] }>()
const { t, locale } = useI18n()
const PAGE_SIZE = 20
const requests = ref<AdminAccountDeletionRequest[]>([])
const nextCursor = ref<string | null>(null)
const history = ref<Array<string | null>>([null])
const pageIndex = ref(0)
const isLoading = ref(true)
const error = ref<unknown>()
const deciding = ref<{ request: AdminAccountDeletionRequest; approve: boolean }>()
const note = ref("")
let revision = 0

interface PageTarget {
  cursor: string | null
  index: number
  history: Array<string | null>
}
async function load(target: PageTarget): Promise<boolean> {
  const current = ++revision
  isLoading.value = true
  error.value = undefined
  try {
    const page = await props.api.deletionRequests({ limit: PAGE_SIZE, ...(target.cursor ? { cursor: target.cursor } : {}) })
    if (current !== revision) return false
    requests.value = page.requests
    nextCursor.value = page.nextCursor
    history.value = target.history
    pageIndex.value = target.index
    return true
  } catch (cause) {
    if (current === revision) error.value = cause
    return false
  } finally {
    if (current === revision) isLoading.value = false
  }
}
const currentTarget = () => ({ cursor: history.value[pageIndex.value]!, index: pageIndex.value, history: history.value })
function retry(): void {
  void load(currentTarget())
}
async function nextPage(): Promise<void> {
  if (!nextCursor.value || isLoading.value) return
  const cursor = nextCursor.value
  await load({ cursor, index: pageIndex.value + 1, history: [...history.value.slice(0, pageIndex.value + 1), cursor] })
}
async function previousPage(): Promise<void> {
  if (pageIndex.value === 0 || isLoading.value) return
  const index = pageIndex.value - 1
  await load({ cursor: history.value[index]!, index, history: history.value.slice(0, index + 1) })
}
function open(request: AdminAccountDeletionRequest, approve: boolean): void {
  note.value = ""
  deciding.value = { request, approve }
}
async function decide(): Promise<void> {
  const decision = deciding.value
  if (!decision) return
  await props.confirmed(() => props.api.reviewDeletionRequest(decision.request.id, decision.approve, note.value.trim() || undefined))
  deciding.value = undefined
  const index = pageIndex.value
  if (await load({ cursor: history.value[index]!, index, history: history.value })) {
    if (requests.value.length === 0 && index > 0) {
      await load({ cursor: history.value[index - 1]!, index: index - 1, history: history.value.slice(0, index) })
    }
  }
}
const date = (value: string) => new Intl.DateTimeFormat(intlLocale(locale.value as AppLocale), { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
const detail = computed(() => deciding.value && (deciding.value.approve
  ? t("siteAdmin.approveDeletionDescription", { name: deciding.value.request.user.name })
  : t("siteAdmin.rejectDeletionDescription", { name: deciding.value.request.user.name })))
void load({ cursor: null, index: 0, history: [null] })
</script>

<template>
  <header class="mb-8">
    <h1 class="ui-page-title">{{ t("siteAdmin.deletionRequests") }}</h1>
    <p class="m-0 mt-1 text-[13px] text-ui-text-muted">{{ t("siteAdmin.deletionRequestsDescription") }}</p>
  </header>
  <p v-if="isLoading && !requests.length" role="status" class="m-0 py-4 text-sm text-ui-text-muted">{{ t("auth.loading") }}</p>
  <div v-else-if="error && !requests.length" class="flex items-center justify-between gap-4">
    <p role="alert" class="m-0 text-sm text-ui-danger">{{ failureMessage(error) }}</p>
    <UiButton @click="retry">{{ t("auth.retry") }}</UiButton>
  </div>
  <template v-else>
    <div v-if="error" class="mb-3 flex items-center justify-between gap-4">
      <p role="alert" class="m-0 text-sm text-ui-danger">{{ failureMessage(error) }}</p>
      <UiButton @click="retry">{{ t("auth.retry") }}</UiButton>
    </div>
    <ul v-if="requests.length" class="ui-card m-0 list-none p-0" :aria-busy="isLoading || undefined">
      <li v-for="request in requests" :key="request.id" class="ui-card-row items-start py-3" :data-deletion-request="request.id">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 text-sm">
            <span class="truncate">{{ request.user.name }}</span>
            <span class="ui-badge shrink-0 bg-ui-warning/10 text-ui-warning">{{ t("siteAdmin.pending") }}</span>
          </div>
          <div class="break-words text-[13px] text-ui-text-muted">{{ request.user.email }}</div>
          <p class="m-0 mt-2 whitespace-pre-wrap break-words text-[13px]">{{ request.reason }}</p>
          <div class="mt-1 text-[13px] text-ui-text-muted">{{ t("siteAdmin.requestedAt", { date: date(request.requestedAt) }) }}</div>
        </div>
        <div class="flex shrink-0 flex-wrap items-center gap-2">
          <UiButton variant="danger" :disabled="isLoading" @click="open(request, true)">{{ t("siteAdmin.approveDeletion") }}</UiButton>
          <UiButton :disabled="isLoading" @click="open(request, false)">{{ t("siteAdmin.rejectDeletion") }}</UiButton>
        </div>
      </li>
    </ul>
    <p v-else class="m-0 py-4 text-sm text-ui-text-muted">{{ t("siteAdmin.noDeletionRequests") }}</p>
    <nav v-if="requests.length" class="mt-4 flex items-center justify-between gap-3" :aria-label="t('siteAdmin.deletionRequests')">
      <UiButton :disabled="isLoading || pageIndex === 0" @click="previousPage">{{ t("billing.previousPage") }}</UiButton>
      <span class="text-[13px] text-ui-text-muted" aria-live="polite">{{ t("billing.pageNumber", { page: pageIndex + 1 }) }}</span>
      <UiButton :disabled="isLoading || !nextCursor" @click="nextPage">{{ t("billing.nextPage") }}</UiButton>
    </nav>
  </template>
  <ConfirmDialog
    v-if="deciding"
    :title="t(deciding.approve ? 'siteAdmin.approveDeletionTitle' : 'siteAdmin.rejectDeletionTitle', { name: deciding.request.user.name })"
    :description="detail ?? ''"
    :confirm-label="t(deciding.approve ? 'siteAdmin.approveDeletion' : 'siteAdmin.rejectDeletion')"
    :tone="deciding.approve ? 'danger' : 'primary'"
    :confirm="decide"
    @close="deciding = undefined"
  >
    <label class="mt-4 flex flex-col gap-1.5 text-sm">{{ t("siteAdmin.reviewNote") }}
      <textarea v-model="note" class="ui-input min-h-20 resize-y" name="deletion-review-note" maxlength="2000" rows="3" />
    </label>
    <p class="m-0 mt-2 text-[13px] text-ui-text-muted">{{ t("siteAdmin.reviewNoteHint") }}</p>
  </ConfirmDialog>
</template>
