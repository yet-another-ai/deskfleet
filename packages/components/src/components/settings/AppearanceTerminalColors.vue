<script setup lang="ts">
import { Check } from "@lucide/vue"
import { RadioGroupItem, RadioGroupRoot } from "reka-ui"
import { computed, ref } from "vue"
import { useI18n } from "vue-i18n"
import { TERMINAL_COLOR_KEYS, TERMINAL_THEME_PRESETS, type TerminalColorKey, type TerminalThemeId } from "@deskfleet/client/terminal-theme"
import { useAppearanceStore } from "../../stores/appearance.ts"
import UiButton from "../common/UiButton.vue"
import AppearanceTerminalColorField from "./AppearanceTerminalColorField.vue"

defineProps<{ disabled?: boolean }>()
const { t } = useI18n()
const appearance = useAppearanceStore()
const colorRevision = ref(0)
const customized = computed(() => Object.keys(appearance.settings.terminalColors).length > 0)
const primaryColors = ["background", "foreground", "cursor", "selectionBackground"] as const
const ansiColors = TERMINAL_COLOR_KEYS.filter(key => !primaryColors.includes(key as typeof primaryColors[number]))
const swatchKeys = ["red", "green", "yellow", "blue", "magenta", "cyan"] as const

async function selectPreset(id: TerminalThemeId): Promise<void> {
  await appearance.set({ terminalTheme: id, terminalColors: {} })
  // An explicit reset also clears drafts whose resolved color did not change.
  if (!appearance.error) colorRevision.value++
}
function saveColor(key: TerminalColorKey, value: string): void {
  void appearance.set({ terminalColors: { ...appearance.settings.terminalColors, [key]: value } })
}
</script>

<template>
  <section data-terminal-colors class="mt-2 border-t border-ui-border pt-5" aria-labelledby="appearance-terminal-colors-label">
    <h2 id="appearance-terminal-colors-label" class="m-0 text-sm font-medium">{{ t("appearance.terminalColors") }}</h2>
    <p class="mb-3 mt-1 text-xs leading-relaxed text-ui-text-muted">{{ t("appearance.terminalColorsHint") }}</p>
    <RadioGroupRoot :model-value="appearance.settings.terminalTheme" :disabled="disabled" :aria-label="t('appearance.terminalPreset')" class="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-5" @update:model-value="selectPreset($event as TerminalThemeId)">
      <RadioGroupItem
        v-for="preset in TERMINAL_THEME_PRESETS" :key="preset.id" :value="preset.id" :data-terminal-theme="preset.id" :aria-label="preset.label"
        class="min-w-0 cursor-pointer rounded-lg border-2 border-transparent p-1 text-left hover:bg-ui-hover data-[state=checked]:border-ui-accent disabled:cursor-default disabled:op-50"
      >
        <div class="rounded-md border border-ui-border/40 px-2.5 py-2" :style="{ backgroundColor: preset.colors.background, color: preset.colors.foreground }" aria-hidden="true">
          <div class="truncate font-mono text-[11px]"><span :style="{ color: preset.colors.green }">❯</span> echo hello</div>
          <div class="mt-2 flex gap-1"><span v-for="key in swatchKeys" :key="key" class="h-1.5 min-w-0 flex-1 rounded-sm" :style="{ backgroundColor: preset.colors[key] }" /></div>
        </div>
        <div class="flex items-center gap-1 px-1 pt-2 text-[11px] font-medium">
          <span class="truncate">{{ preset.label }}</span>
          <Check v-if="appearance.settings.terminalTheme === preset.id" :size="12" class="ml-auto shrink-0 text-ui-accent" aria-hidden="true" />
        </div>
      </RadioGroupItem>
    </RadioGroupRoot>
    <slot />
    <div class="mb-3 mt-4 flex items-center justify-between gap-3">
      <span class="text-xs font-medium">{{ t(customized ? "appearance.customTerminalColors" : "appearance.customizeTerminalColors") }}</span>
      <UiButton data-terminal-colors-reset variant="ghost" size="sm" :disabled="disabled || !customized" @click="selectPreset(appearance.settings.terminalTheme)">{{ t("appearance.resetTerminalColors") }}</UiButton>
    </div>
    <div class="grid grid-cols-2 gap-x-4 gap-y-3">
      <AppearanceTerminalColorField v-for="key in primaryColors" :key="`${colorRevision}:${key}`" :color-key="key" :model-value="appearance.terminalTheme[key]" :disabled="disabled" @update:model-value="saveColor(key, $event)" />
    </div>
    <details class="mt-4 border-t border-ui-border pt-3">
      <summary class="cursor-pointer text-xs font-medium">{{ t("appearance.ansiColors") }}</summary>
      <div class="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <AppearanceTerminalColorField v-for="key in ansiColors" :key="`${colorRevision}:${key}`" :color-key="key" :model-value="appearance.terminalTheme[key]" :disabled="disabled" @update:model-value="saveColor(key, $event)" />
      </div>
    </details>
  </section>
</template>
