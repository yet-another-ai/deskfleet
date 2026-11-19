<script setup lang="ts">
import { Check, LoaderCircle, RotateCw, X } from "@lucide/vue"
import { DialogTitle } from "reka-ui"
import { computed, nextTick, ref, useTemplateRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { AgentChoice } from "../../../../client/src/agent-configuration.ts"
import {
  PERIODIC_TABLE_ELEMENTS,
  buildGeminiPeriodicEntries,
  extractGeminiVariantLabel,
  type GeminiPeriodicEntry,
  type PeriodicElement,
} from "../../services/gemini-periodic-table.ts"
import UiButton from "../common/UiButton.vue"
import UiDialog from "../common/UiDialog.vue"

const props = defineProps<{
  models: AgentChoice[]
  currentModel?: string
  requestedModel?: string
  loading?: boolean
  error?: string | null
  disabled?: boolean
}>()

const emit = defineEmits<{
  select: [modelId: string]
  reload: []
  close: []
}>()

const { t, te } = useI18n()
const dialog = useTemplateRef<InstanceType<typeof UiDialog>>("dialog")
const gridRef = useTemplateRef<HTMLElement>("gridRef")
const detailRef = useTemplateRef<HTMLElement>("detailRef")

const entries = computed(() => buildGeminiPeriodicEntries(props.models))
const availableEntries = computed(() =>
  [...entries.value.values()].sort((a, b) => a.element.number - b.element.number),
)
const extraEntries = computed(() =>
  availableEntries.value.filter(entry => entry.element.row === undefined),
)
const activeModelId = computed(() => props.requestedModel ?? props.currentModel)
const selectedElementNumber = computed(() => {
  if (!activeModelId.value) return undefined
  return availableEntries.value.find(entry => entry.models.some(model => model.id === activeModelId.value))?.element.number
})

const hoveredNumber = ref<number | undefined>()
const pinnedNumber = ref<number | undefined>()
const hoveredVariantId = ref<string | undefined>()

watch(availableEntries, list => {
  if (pinnedNumber.value !== undefined && !list.some(entry => entry.element.number === pinnedNumber.value)) {
    pinnedNumber.value = undefined
  }
  if (hoveredNumber.value !== undefined && !list.some(entry => entry.element.number === hoveredNumber.value)) {
    hoveredNumber.value = undefined
  }
})

const inspectedEntry = computed<GeminiPeriodicEntry | undefined>(() => {
  const number = hoveredNumber.value ?? pinnedNumber.value ?? selectedElementNumber.value
  if (number !== undefined) {
    const found = entries.value.get(number)
    if (found) return found
  }
  return availableEntries.value[0]
})

const inspectedModel = computed<AgentChoice | undefined>(() => {
  const entry = inspectedEntry.value
  if (!entry) return undefined
  if (hoveredVariantId.value) {
    const hovered = entry.models.find(model => model.id === hoveredVariantId.value)
    if (hovered) return hovered
  }
  if (activeModelId.value) {
    const selected = entry.models.find(model => model.id === activeModelId.value)
    if (selected) return selected
  }
  return entry.models[0]
})

function descriptionFor(model: AgentChoice, element: PeriodicElement): string {
  const native = model.description?.trim()
  if (native) return native
  const key = `composer.geminiPeriodicTable.fallbackDescriptions.${element.symbol}`
  if (te(key)) return t(key)
  return t("composer.geminiPeriodicTable.fallbackDescriptions.default", { name: element.name })
}

function isElementSelected(number: number): boolean {
  return selectedElementNumber.value === number
}

function isElementInspected(number: number): boolean {
  return inspectedEntry.value?.element.number === number
}

function hoverElement(number: number): void {
  hoveredNumber.value = number
  hoveredVariantId.value = undefined
}

function clearHover(): void {
  hoveredNumber.value = undefined
  hoveredVariantId.value = undefined
}

function selectModel(modelId: string): void {
  if (props.disabled) return
  emit("select", modelId)
  dialog.value?.close()
}

async function activateElement(entry: GeminiPeriodicEntry): Promise<void> {
  if (props.disabled) return
  if (entry.models.length === 1) {
    selectModel(entry.models[0]!.id)
    return
  }
  pinnedNumber.value = entry.element.number
  hoveredNumber.value = undefined
  hoveredVariantId.value = undefined
  await nextTick()
  const activeButton = detailRef.value?.querySelector<HTMLButtonElement>('[data-periodic-variant][aria-pressed="true"]')
    ?? detailRef.value?.querySelector<HTMLButtonElement>("[data-periodic-variant]")
  activeButton?.focus()
}

function onElementKeydown(event: KeyboardEvent, number: number): void {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
  const list = availableEntries.value
  if (list.length <= 1) return
  const index = list.findIndex(entry => entry.element.number === number)
  if (index === -1) return
  event.preventDefault()
  const nextIndex = (index + (event.key === "ArrowRight" ? 1 : -1) + list.length) % list.length
  const next = list[nextIndex]!
  hoveredNumber.value = next.element.number
  gridRef.value?.querySelector<HTMLButtonElement>(`[data-atomic-number="${next.element.number}"]`)?.focus()
}

function onOpenAutoFocus(event: Event): void {
  const targetNumber = selectedElementNumber.value ?? availableEntries.value[0]?.element.number
  if (targetNumber === undefined) return
  const target = gridRef.value?.querySelector<HTMLButtonElement>(`[data-atomic-number="${targetNumber}"]`)
  if (!target) return
  event.preventDefault()
  target.focus()
}

function close(): void {
  dialog.value?.close()
}
</script>

<template>
  <UiDialog
    ref="dialog"
    data-gemini-periodic-table-dialog
    class="w-[min(56rem,calc(100vw-2rem))] p-5 sm:p-6"
    @open-auto-focus="onOpenAutoFocus"
    @close="emit('close')"
  >
    <div class="mb-4 flex items-center justify-between gap-3">
      <DialogTitle class="ui-dialog-title flex items-center gap-2">
        <span>{{ t("composer.geminiPeriodicTable.title") }}</span>
      </DialogTitle>
      <UiButton
        variant="ghost"
        size="icon"
        type="button"
        class="h-7 w-7"
        :label="t('common.close')"
        data-periodic-close
        @click="close"
      >
        <X :size="15" aria-hidden="true" />
      </UiButton>
    </div>

    <div
      ref="gridRef"
      class="-mx-1.5 overflow-x-auto px-1.5 py-1.5"
      @pointerleave="clearHover"
    >
      <div class="periodic-grid mx-auto min-w-[42rem]" role="group" :aria-label="t('composer.geminiPeriodicTable.gridLabel')">
        <!-- Classic periodic table center hero nestled in columns 3..12, rows 1..3 -->
        <div class="periodic-hero flex flex-col justify-center px-3.5 py-1">
          <span class="text-[10px] font-medium uppercase tracking-[0.2em] text-ui-text-faint">
            {{ t("composer.geminiPeriodicTable.eyebrow") }}
          </span>
          <div class="mt-1 text-[1.75rem] font-semibold tracking-tight text-ui-text sm:text-[2.125rem] sm:leading-none">
            Gemini 4
          </div>
          <div class="mt-2.5 flex items-center gap-2 text-xs text-ui-text-muted">
            <span class="inline-flex h-5 min-w-5 items-center justify-center rounded-md border border-ui-border-strong bg-ui-control px-1.5 text-[11px] font-semibold tabular-nums text-ui-text shadow-ui-card">
              {{ availableEntries.length }}
            </span>
            <span>{{ t("composer.geminiPeriodicTable.availableLabel", availableEntries.length) }}</span>
          </div>
        </div>

        <!-- Lanthanides placeholder in row 6, column 3 -->
        <div
          class="periodic-tile periodic-tile-dim periodic-tile-faded"
          style="grid-row: 6; grid-column: 3"
          aria-hidden="true"
        >
          <span class="text-[10px] font-medium tracking-tight opacity-65">57–71</span>
        </div>

        <!-- Main 18×6 periodic table elements -->
        <template v-for="element in PERIODIC_TABLE_ELEMENTS" :key="element.number">
          <button
            v-if="entries.has(element.number)"
            type="button"
            class="periodic-tile periodic-tile-active ui-motion"
            :class="[
              isElementSelected(element.number) && 'periodic-tile-selected',
              isElementInspected(element.number) && 'periodic-tile-inspected',
            ]"
            :style="{
              gridRow: element.row,
              gridColumn: element.col,
              '--el-rgb': element.rgb,
            }"
            :data-periodic-element="element.symbol"
            :data-atomic-number="element.number"
            :aria-pressed="isElementSelected(element.number)"
            :aria-label="`${element.name} (${element.symbol}) — ${entries.get(element.number)!.models[0]!.name}`"
            :disabled="disabled"
            @pointerenter="hoverElement(element.number)"
            @focus="hoverElement(element.number)"
            @keydown="onElementKeydown($event, element.number)"
            @click="activateElement(entries.get(element.number)!)"
          >
            <span class="periodic-number">{{ element.number }}</span>
            <span v-if="isElementSelected(element.number)" class="periodic-dot" aria-hidden="true" />
            <span class="periodic-symbol">{{ element.symbol }}</span>
          </button>
          <div
            v-else
            class="periodic-tile periodic-tile-dim"
            :class="element.row === 6 && 'periodic-tile-faded'"
            :style="{ gridRow: element.row, gridColumn: element.col }"
            aria-hidden="true"
          >
            <span class="periodic-number">{{ element.number }}</span>
            <span class="periodic-symbol">{{ element.symbol }}</span>
          </div>
        </template>
      </div>

      <!-- Supplemental strip for any future Gemini 4 models using lanthanide / actinide / period-7 elements -->
      <div v-if="extraEntries.length" class="mt-2 flex flex-wrap items-center gap-1.5 px-0.5">
        <button
          v-for="entry in extraEntries"
          :key="entry.element.number"
          type="button"
          class="periodic-tile periodic-tile-active h-10 w-10 ui-motion"
          :class="[
            isElementSelected(entry.element.number) && 'periodic-tile-selected',
            isElementInspected(entry.element.number) && 'periodic-tile-inspected',
          ]"
          :style="{ '--el-rgb': entry.element.rgb }"
          :data-periodic-element="entry.element.symbol"
          :data-atomic-number="entry.element.number"
          :aria-pressed="isElementSelected(entry.element.number)"
          :aria-label="`${entry.element.name} (${entry.element.symbol}) — ${entry.models[0]!.name}`"
          :disabled="disabled"
          @pointerenter="hoverElement(entry.element.number)"
          @focus="hoverElement(entry.element.number)"
          @keydown="onElementKeydown($event, entry.element.number)"
          @click="activateElement(entry)"
        >
          <span class="periodic-number">{{ entry.element.number }}</span>
          <span v-if="isElementSelected(entry.element.number)" class="periodic-dot" aria-hidden="true" />
          <span class="periodic-symbol">{{ entry.element.symbol }}</span>
        </button>
      </div>
    </div>

    <!-- Model detail & description card -->
    <div
      ref="detailRef"
      data-periodic-detail
      class="periodic-detail mt-4 min-h-[5.75rem] rounded-xl border border-ui-border bg-ui-canvas/75 px-4 py-3.5"
    >
      <div v-if="loading && !models.length" role="status" class="flex min-h-[3.75rem] items-center gap-2 text-[13px] text-ui-text-muted">
        <LoaderCircle :size="15" class="shrink-0 animate-spin" aria-hidden="true" />
        <span>{{ t("composer.loadingConfiguration") }}</span>
      </div>

      <div v-else-if="error && !availableEntries.length" class="flex min-h-[3.75rem] flex-col items-start justify-center gap-2.5 text-[13px]">
        <p role="alert" class="m-0 break-words text-ui-danger">{{ error }}</p>
        <UiButton type="button" @click="emit('reload')">
          <RotateCw :size="13" aria-hidden="true" />
          {{ t("composer.reloadConfiguration") }}
        </UiButton>
      </div>

      <div v-else-if="!inspectedEntry || !inspectedModel" class="flex min-h-[3.75rem] flex-wrap items-center justify-between gap-3 text-[13px] text-ui-text-muted">
        <p class="m-0">{{ t("composer.geminiPeriodicTable.empty") }}</p>
        <UiButton type="button" @click="emit('reload')">
          <RotateCw :size="13" aria-hidden="true" />
          {{ t("composer.reloadConfiguration") }}
        </UiButton>
      </div>

      <div v-else class="flex items-start gap-3.5">
        <div
          class="periodic-badge relative flex h-13 w-13 shrink-0 items-center justify-center rounded-[0.625rem]"
          :style="{ '--el-rgb': inspectedEntry.element.rgb }"
          aria-hidden="true"
        >
          <span class="periodic-badge-number">{{ inspectedEntry.element.number }}</span>
          <span class="periodic-badge-symbol">{{ inspectedEntry.element.symbol }}</span>
        </div>

        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span class="text-[15px] font-semibold text-ui-text" data-periodic-model-name>{{ inspectedModel.name }}</span>
            <code class="font-mono text-xs text-ui-text-faint" data-periodic-model-id>{{ inspectedModel.id }}</code>
            <span
              v-if="activeModelId === inspectedModel.id"
              class="inline-flex items-center gap-1 rounded-full bg-ui-accent/12 px-2 py-0.5 text-[11px] font-medium text-ui-accent"
            >
              <LoaderCircle v-if="requestedModel === inspectedModel.id" :size="11" class="animate-spin" aria-hidden="true" />
              <Check v-else :size="11" aria-hidden="true" />
              {{ t("composer.geminiPeriodicTable.current") }}
            </span>
          </div>

          <p class="m-0 mt-1 text-[13px] leading-relaxed text-ui-text-muted" data-periodic-description>
            {{ descriptionFor(inspectedModel, inspectedEntry.element) }}
          </p>

          <div
            v-if="inspectedEntry.models.length > 1"
            class="mt-2.5 flex flex-wrap items-center gap-1.5"
            role="group"
            :aria-label="t('composer.geminiPeriodicTable.chooseVariant')"
          >
            <button
              v-for="variant in inspectedEntry.models"
              :key="variant.id"
              type="button"
              class="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium ui-motion disabled:cursor-default disabled:opacity-50"
              :class="activeModelId === variant.id
                ? 'border-ui-accent bg-ui-accent/12 text-ui-accent'
                : 'border-ui-border-strong bg-ui-control text-ui-text hover:bg-ui-control-hover'"
              :data-periodic-variant="variant.id"
              :aria-pressed="activeModelId === variant.id"
              :disabled="disabled"
              @pointerenter="hoveredVariantId = variant.id"
              @focus="hoveredVariantId = variant.id"
              @click="selectModel(variant.id)"
            >
              <Check v-if="activeModelId === variant.id" :size="12" aria-hidden="true" />
              <span>{{ extractGeminiVariantLabel(variant, inspectedEntry.element) }}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  </UiDialog>
</template>

<style scoped>
.periodic-grid {
  display: grid;
  grid-template-columns: repeat(18, minmax(2.2rem, 1fr));
  grid-template-rows: repeat(6, 2.75rem);
  gap: 0.3125rem;
}

.periodic-hero {
  grid-column: 3 / 13;
  grid-row: 1 / 4;
}

.periodic-tile {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 0.5rem;
  border-width: 1px;
  padding: 0;
  user-select: none;
}

.periodic-tile-dim {
  border-color: color-mix(in srgb, var(--ui-color-border) 82%, transparent);
  background: color-mix(in srgb, var(--ui-color-canvas) 72%, var(--ui-color-surface));
  color: var(--ui-color-text-faint);
  box-shadow: inset 0 1px 0 var(--ui-highlight);
}

:global(:is(:root.dark:not([data-theme="light"]), [data-theme="dark"])) .periodic-tile-dim {
  border-color: rgb(255 255 255 / 0.055);
  background: rgb(255 255 255 / 0.028);
  color: rgb(231 233 239 / 0.44);
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.035);
}

.periodic-tile-faded {
  opacity: 0.48;
  -webkit-mask-image: linear-gradient(to bottom, #000 0%, transparent 94%);
  mask-image: linear-gradient(to bottom, #000 0%, transparent 94%);
}

.periodic-tile-active {
  cursor: pointer;
  border-color: rgb(var(--el-rgb) / 0.46);
  background: linear-gradient(
    180deg,
    rgb(var(--el-rgb) / 0.2),
    rgb(var(--el-rgb) / 0.11)
  );
  color: color-mix(in srgb, rgb(var(--el-rgb)) 80%, var(--ui-color-text));
  box-shadow:
    inset 0 1px 0 rgb(255 255 255 / 0.35),
    0 1px 2px rgb(var(--el-rgb) / 0.08);
}

:global(:is(:root.dark:not([data-theme="light"]), [data-theme="dark"])) .periodic-tile-active {
  border-color: rgb(var(--el-rgb) / 0.56);
  background: linear-gradient(
    180deg,
    rgb(var(--el-rgb) / 0.36),
    rgb(var(--el-rgb) / 0.2)
  );
  color: color-mix(in srgb, rgb(var(--el-rgb)) 30%, #ffffff);
  box-shadow:
    inset 0 1px 0 rgb(255 255 255 / 0.16),
    0 2px 8px rgb(0 0 0 / 0.22);
}

.periodic-tile-active:hover:not(:disabled),
.periodic-tile-active:focus-visible:not(:disabled) {
  z-index: 2;
  scale: 1.07;
  border-color: rgb(var(--el-rgb) / 0.9);
  box-shadow:
    0 6px 18px rgb(var(--el-rgb) / 0.26),
    inset 0 1px 0 rgb(255 255 255 / 0.3);
}

.periodic-tile-active:active:not(:disabled) {
  scale: 0.98;
}

.periodic-tile-inspected:not(.periodic-tile-selected) {
  border-color: rgb(var(--el-rgb) / 0.85);
}

.periodic-tile-selected {
  z-index: 1;
  border-color: rgb(var(--el-rgb) / 0.96);
  box-shadow:
    0 0 0 2px rgb(var(--el-rgb) / 0.36),
    0 6px 18px rgb(var(--el-rgb) / 0.28),
    inset 0 1px 0 rgb(255 255 255 / 0.3);
}

.periodic-tile-active:disabled {
  cursor: default;
  opacity: 0.5;
}

.periodic-number {
  position: absolute;
  top: 0.2rem;
  left: 0.28rem;
  font-size: 0.53125rem;
  font-weight: 500;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  opacity: 0.68;
}

.periodic-dot {
  position: absolute;
  top: 0.26rem;
  right: 0.26rem;
  width: 0.3125rem;
  height: 0.3125rem;
  border-radius: 9999px;
  background: currentColor;
  box-shadow: 0 0 6px rgb(var(--el-rgb) / 0.95);
}

.periodic-symbol {
  margin-top: 0.14rem;
  font-size: 0.9375rem;
  font-weight: 500;
  line-height: 1;
  letter-spacing: -0.02em;
}

.periodic-tile-active .periodic-symbol {
  font-size: 1rem;
  font-weight: 650;
}

.periodic-badge {
  border: 1px solid rgb(var(--el-rgb) / 0.48);
  background: linear-gradient(
    180deg,
    rgb(var(--el-rgb) / 0.22),
    rgb(var(--el-rgb) / 0.12)
  );
  color: color-mix(in srgb, rgb(var(--el-rgb)) 80%, var(--ui-color-text));
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.3);
}

:global(:is(:root.dark:not([data-theme="light"]), [data-theme="dark"])) .periodic-badge {
  border-color: rgb(var(--el-rgb) / 0.58);
  background: linear-gradient(
    180deg,
    rgb(var(--el-rgb) / 0.38),
    rgb(var(--el-rgb) / 0.22)
  );
  color: color-mix(in srgb, rgb(var(--el-rgb)) 30%, #ffffff);
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.16);
}

.periodic-badge-number {
  position: absolute;
  top: 0.3rem;
  left: 0.38rem;
  font-size: 0.625rem;
  font-weight: 500;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  opacity: 0.72;
}

.periodic-badge-symbol {
  margin-top: 0.18rem;
  font-size: 1.3125rem;
  font-weight: 650;
  line-height: 1;
  letter-spacing: -0.02em;
}
</style>
