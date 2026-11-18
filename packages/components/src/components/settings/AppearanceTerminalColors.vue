<script setup lang="ts">
import { Check, Moon, Sun } from "@lucide/vue"
import { RadioGroupItem, RadioGroupRoot } from "reka-ui"
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { resolveTerminalTheme, TERMINAL_COLOR_KEYS, TERMINAL_THEME_PRESETS, type TerminalColorKey, type TerminalThemeId } from "@deskfleet/client/terminal-theme"
import { useAppearanceStore } from "../../stores/appearance.ts"
import UiButton from "../common/UiButton.vue"
import UiSwitch from "../common/UiSwitch.vue"
import AppearanceTerminalColorField from "./AppearanceTerminalColorField.vue"

defineProps<{ disabled?: boolean }>()
const { t } = useI18n()
const appearance = useAppearanceStore()
const colorRevision = ref(0)
const modeOptions = [{ value: "light", label: "appearance.light", icon: Sun }, { value: "dark", label: "appearance.dark", icon: Moon }] as const
const editingMode = ref<"light" | "dark">(appearance.isDark ? "dark" : "light")
watch([() => appearance.isDark, () => appearance.settings.terminalSeparateThemes], ([dark]) => { editingMode.value = dark ? "dark" : "light" })
const editingLight = computed(() => appearance.settings.terminalSeparateThemes && editingMode.value === "light")
const activePresetId = computed(() => editingLight.value ? appearance.settings.terminalLightTheme : appearance.settings.terminalTheme)
const activeOverrides = computed(() => editingLight.value ? appearance.settings.terminalLightColors : appearance.settings.terminalColors)
const editingColors = computed(() => resolveTerminalTheme(activePresetId.value, activeOverrides.value))
const customized = computed(() => Object.keys(activeOverrides.value).length > 0)
const primaryColors = ["background", "foreground", "cursor", "selectionBackground"] as const
const ansiColors = TERMINAL_COLOR_KEYS.filter(key => !primaryColors.includes(key as typeof primaryColors[number]))
const swatchKeys = ["red", "green", "yellow", "blue", "magenta", "cyan"] as const

async function selectPreset(id: TerminalThemeId): Promise<void> {
  await appearance.set(editingLight.value ? { terminalLightTheme: id, terminalLightColors: {} } : { terminalTheme: id, terminalColors: {} })
  // An explicit reset also clears drafts whose resolved color did not change.
  if (!appearance.error) colorRevision.value++
}
function saveColor(key: TerminalColorKey, value: string): void {
  const next = { ...activeOverrides.value, [key]: value }
  void appearance.set(editingLight.value ? { terminalLightColors: next } : { terminalColors: next })
}
</script>

<template>
  <section data-terminal-colors class="mt-2 border-t border-ui-border pt-5" aria-labelledby="appearance-terminal-colors-label">
    <h2 id="appearance-terminal-colors-label" class="m-0 text-sm font-medium">{{ t("appearance.terminalColors") }}</h2>
    <p class="mb-3 mt-1 text-xs leading-relaxed text-ui-text-muted">{{ t("appearance.terminalColorsHint") }}</p>
    <div class="mb-4 flex items-center justify-between gap-6">
      <div>
        <div id="appearance-terminal-separate-themes-label" class="text-[13px] font-medium">{{ t("appearance.terminalSeparateThemes") }}</div>
        <p id="appearance-terminal-separate-themes-description" class="mb-0 mt-1 text-xs leading-relaxed text-ui-text-muted">{{ t("appearance.terminalSeparateThemesHint") }}</p>
      </div>
      <UiSwitch data-terminal-separate-themes :model-value="appearance.settings.terminalSeparateThemes" :disabled="disabled" aria-labelledby="appearance-terminal-separate-themes-label" aria-describedby="appearance-terminal-separate-themes-description" @update:model-value="appearance.set({ terminalSeparateThemes: $event })" />
    </div>
    <RadioGroupRoot v-if="appearance.settings.terminalSeparateThemes" :model-value="editingMode" :disabled="disabled" orientation="horizontal" :aria-label="t('appearance.terminalThemeMode')" class="mb-3 inline-flex rounded-lg border border-ui-border-strong bg-ui-control p-0.5" @update:model-value="editingMode = $event as 'light' | 'dark'">
      <RadioGroupItem v-for="option in modeOptions" :key="option.value" :value="option.value" :data-terminal-theme-mode="option.value" :aria-label="t(option.label)" class="inline-flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1 text-[13px] font-medium text-ui-text-muted ui-motion hover:text-ui-text enabled:active:scale-[0.97] data-[state=checked]:bg-ui-active data-[state=checked]:text-ui-text disabled:cursor-default disabled:op-50">
        <component :is="option.icon" :size="13" :stroke-width="1.75" aria-hidden="true" />
        <span>{{ t(option.label) }}</span>
      </RadioGroupItem>
    </RadioGroupRoot>
    <RadioGroupRoot :model-value="activePresetId" :disabled="disabled" :aria-label="t('appearance.terminalPreset')" class="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3" @update:model-value="selectPreset($event as TerminalThemeId)">
      <RadioGroupItem
        v-for="preset in TERMINAL_THEME_PRESETS" :key="preset.id" :value="preset.id" :data-terminal-theme="preset.id" :aria-label="preset.label"
        class="min-w-0 cursor-pointer rounded-lg border-2 border-transparent p-1 text-left ui-motion hover:bg-ui-hover data-[state=checked]:border-ui-accent data-[state=checked]:bg-ui-accent/6 data-[state=checked]:hover:bg-ui-accent/12 disabled:cursor-default disabled:op-50"
      >
        <div class="rounded-md border border-ui-border/40 px-2.5 py-2" :style="{ backgroundColor: preset.colors.background, color: preset.colors.foreground }" aria-hidden="true">
          <div class="truncate font-mono text-[11px]"><span :style="{ color: preset.colors.green }">❯</span> echo hello</div>
          <div class="mt-2 flex gap-1"><span v-for="key in swatchKeys" :key="key" class="h-1.5 min-w-0 flex-1 rounded-sm" :style="{ backgroundColor: preset.colors[key] }" /></div>
        </div>
        <div class="flex items-center gap-1 px-1 pt-2 text-[11px] font-medium">
          <span class="truncate">{{ preset.label }}</span>
          <Check v-if="activePresetId === preset.id" :size="12" class="ml-auto shrink-0 text-ui-accent" aria-hidden="true" />
        </div>
      </RadioGroupItem>
    </RadioGroupRoot>
    <slot :theme="editingColors" />
    <div class="mb-3 mt-4 flex items-center justify-between gap-3">
      <span class="text-xs font-medium">{{ t(customized ? "appearance.customTerminalColors" : "appearance.customizeTerminalColors") }}</span>
      <UiButton data-terminal-colors-reset variant="ghost" size="sm" :disabled="disabled || !customized" @click="selectPreset(activePresetId)">{{ t("appearance.resetTerminalColors") }}</UiButton>
    </div>
    <div class="grid grid-cols-2 gap-x-4 gap-y-3">
      <AppearanceTerminalColorField v-for="key in primaryColors" :key="`${editingLight}:${colorRevision}:${key}`" :color-key="key" :model-value="editingColors[key]" :disabled="disabled" @update:model-value="saveColor(key, $event)" />
    </div>
    <details class="mt-4 border-t border-ui-border pt-3">
      <summary class="cursor-pointer text-xs font-medium">{{ t("appearance.ansiColors") }}</summary>
      <div class="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <AppearanceTerminalColorField v-for="key in ansiColors" :key="`${editingLight}:${colorRevision}:${key}`" :color-key="key" :model-value="editingColors[key]" :disabled="disabled" @update:model-value="saveColor(key, $event)" />
      </div>
    </details>
  </section>
</template>
