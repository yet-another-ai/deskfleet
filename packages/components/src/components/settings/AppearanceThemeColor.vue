<script setup lang="ts">
import { symbolicShadeValues } from "@proj-airi/chromatic"
import { computed, onScopeDispose } from "vue"
import { useI18n } from "vue-i18n"
import { useInertialRange } from "../../composables/useInertialRange.ts"
import { chromaticShadeHex, useAppearanceStore } from "../../stores/appearance.ts"
import UiButton from "../common/UiButton.vue"
import UiSwitch from "../common/UiSwitch.vue"

defineProps<{ disabled?: boolean }>()
const { t } = useI18n()
const appearance = useAppearanceStore()

const customized = computed(() => appearance.activeThemeHue !== null || appearance.settings.themeHueDynamic)

const { value: hue, startDrag, moveDrag, endDrag, onInput, onChange, onKeydown } = useInertialRange({
  value: () => appearance.themeHue,
  min: 0,
  max: 360,
  enabled: () => appearance.ready && !appearance.settings.themeHueDynamic,
  preview: value => appearance.previewThemeHue(value),
  commit: value => appearance.set({ themeHue: value, themeHueDynamic: false }),
  afterCommit() {
    if (!appearance.error) appearance.previewThemeHue(null)
  },
})
// Preview belongs to the mounted editor; late saves cannot clean up a new editor.
onScopeDispose(() => appearance.previewThemeHue(null))

async function toggleDynamic(enabled: boolean): Promise<void> {
  await appearance.set({ themeHueDynamic: enabled })
  if (enabled && appearance.settings.themeHueDynamic && !appearance.error) appearance.previewThemeHue(null)
}

async function reset(): Promise<void> {
  await appearance.set({ themeHue: null, themeHueDynamic: false })
  if (!appearance.error) appearance.previewThemeHue(null)
}
</script>

<template>
  <section data-theme-color class="mt-5 border-t border-ui-border pt-5" aria-labelledby="appearance-theme-color-label">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 id="appearance-theme-color-label" class="m-0 text-sm font-medium">{{ t("appearance.themeColor") }}</h2>
        <p id="appearance-theme-color-description" class="mb-0 mt-1 text-xs leading-relaxed text-ui-text-muted">{{ t("appearance.themeColorHint") }}</p>
      </div>
      <div class="flex items-center gap-4">
        <div class="flex items-center gap-2">
          <span id="appearance-theme-color-rgb-label" class="text-xs font-medium text-ui-text-muted">{{ t("appearance.themeColorRgb") }}</span>
          <UiSwitch
            :model-value="appearance.settings.themeHueDynamic"
            :disabled="disabled"
            aria-labelledby="appearance-theme-color-rgb-label"
            aria-describedby="appearance-theme-color-description"
            @update:model-value="toggleDynamic($event)"
          />
        </div>
        <UiButton
          data-theme-color-reset
          variant="ghost"
          size="sm"
          :disabled="disabled || !customized"
          @click="reset()"
        >
          {{ t("appearance.resetThemeColor") }}
        </UiButton>
      </div>
    </div>

    <div class="mt-3 flex flex-col gap-2">
      <input
        id="appearance-theme-hue"
        data-theme-hue-slider
        type="range"
        min="0"
        max="360"
        step="0.01"
        :value="hue"
        :disabled="!appearance.ready || appearance.settings.themeHueDynamic"
        :aria-label="t('appearance.themeColorHue')"
        aria-describedby="appearance-theme-color-description"
        class="chromatic-hue-slider"
        @input="onInput"
        @change="onChange"
        @keydown="onKeydown"
        @pointerdown="startDrag"
        @pointermove="moveDrag"
        @pointerup="endDrag"
        @pointercancel="endDrag"
        @lostpointercapture="endDrag"
      >
      <div
        data-theme-shade-bar
        aria-hidden="true"
        class="flex h-6 overflow-hidden rounded-md text-center font-mono text-[10px] leading-6"
      >
        <span
          v-for="shade in symbolicShadeValues"
          :key="shade"
          :data-theme-shade="shade"
          class="min-w-0 flex-1 select-none"
          :class="shade >= 600 ? 'text-white' : 'text-[#1b1f2b]'"
          :style="{ backgroundColor: chromaticShadeHex(shade, appearance.themeHue) }"
        >{{ shade }}</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.chromatic-hue-slider {
  appearance: none;
  width: 100%;
  height: 1.5rem;
  margin-block: 0.125rem;
  border-radius: 0.375rem;
  outline: none;
  cursor: pointer;
  touch-action: none;
  background: linear-gradient(
    to right,
    oklch(85% 0.2 0),
    oklch(85% 0.2 60),
    oklch(85% 0.2 120),
    oklch(85% 0.2 180),
    oklch(85% 0.2 240),
    oklch(85% 0.2 300),
    oklch(85% 0.2 360)
  );
  transition: opacity var(--ui-duration-base) var(--ui-ease-out);
}

.chromatic-hue-slider:disabled {
  opacity: 0.25;
  cursor: not-allowed;
}

.chromatic-hue-slider {
  --thumb-bg: #525252;
  --thumb-border: #737373;
  --thumb-hover-bg: #262626;
}

:global(:is(:root.dark:not([data-theme="light"]), [data-theme="dark"])) .chromatic-hue-slider {
  --thumb-bg: #f5f5f5;
  --thumb-border: #ffffff;
  --thumb-hover-bg: #d4d4d4;
}

:global([data-theme="light"]) .chromatic-hue-slider {
  --thumb-bg: #525252;
  --thumb-border: #737373;
  --thumb-hover-bg: #262626;
}

.chromatic-hue-slider::-webkit-slider-thumb {
  appearance: none;
  width: 0.25rem;
  height: 2rem;
  border-radius: 0.25rem;
  background: var(--thumb-bg);
  border: 1.5px solid var(--thumb-border);
  box-shadow: 0 2px 6px rgb(0 0 0 / 28%);
  cursor: col-resize;
  transition:
    background-color 200ms var(--ui-ease-out),
    width 200ms var(--ui-ease-out),
    height 200ms var(--ui-ease-out),
    transform 200ms var(--ui-ease-out);
}

.chromatic-hue-slider:not(:disabled):hover::-webkit-slider-thumb {
  width: 0.375rem;
  height: 2.125rem;
  background: var(--thumb-hover-bg);
}

.chromatic-hue-slider::-moz-range-thumb {
  appearance: none;
  width: 0.25rem;
  height: 2rem;
  border-radius: 0.25rem;
  background: var(--thumb-bg);
  border: 1.5px solid var(--thumb-border);
  box-shadow: 0 2px 6px rgb(0 0 0 / 28%);
  cursor: col-resize;
  transition:
    background-color 200ms var(--ui-ease-out),
    width 200ms var(--ui-ease-out),
    height 200ms var(--ui-ease-out),
    transform 200ms var(--ui-ease-out);
}

.chromatic-hue-slider:not(:disabled):hover::-moz-range-thumb {
  width: 0.375rem;
  height: 2.125rem;
  background: var(--thumb-hover-bg);
}

@media (prefers-reduced-motion: reduce) {
  .chromatic-hue-slider::-webkit-slider-thumb { transition: none; }
  .chromatic-hue-slider::-moz-range-thumb { transition: none; }
}
</style>
