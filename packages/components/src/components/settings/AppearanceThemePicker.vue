<script setup lang="ts">
import { Check, Moon, Sun, SunMoon } from "@lucide/vue"
import { RadioGroupItem, RadioGroupRoot } from "reka-ui"
import { useI18n } from "vue-i18n"
import type { AppearanceSettings } from "@deskfleet/client/appearance"

defineProps<{ modelValue: AppearanceSettings["theme"]; disabled?: boolean }>()
const emit = defineEmits<{ "update:modelValue": [value: AppearanceSettings["theme"]] }>()
const { t } = useI18n()
const options = [
  { value: "light", label: "appearance.light", icon: Sun },
  { value: "dark", label: "appearance.dark", icon: Moon },
  { value: "system", label: "appearance.followSystem", icon: SunMoon },
] as const
</script>

<template>
  <RadioGroupRoot :model-value="modelValue" :disabled="disabled" :aria-label="t('appearance.theme')" class="grid grid-cols-3 gap-3" @update:model-value="emit('update:modelValue', $event as AppearanceSettings['theme'])">
    <RadioGroupItem v-for="option in options" :key="option.value" :value="option.value" :data-appearance-theme="option.value" :aria-label="t(option.label)" class="theme-option group min-w-0 cursor-pointer rounded-xl border-2 border-transparent p-1 text-left transition-colors hover:bg-ui-hover data-[state=checked]:border-ui-accent data-[state=checked]:bg-ui-accent/5 disabled:cursor-default disabled:op-50">
      <div class="theme-picture" :data-mode="option.value" aria-hidden="true">
        <div v-for="palette in option.value === 'system' ? ['light', 'dark'] : [option.value]" :key="palette" class="mini-app" :data-palette="palette">
          <div class="mini-titlebar"><i /><i /><i /><span /></div>
          <div class="mini-sidebar">
            <span class="mini-brand"><i /><b /></span>
            <span class="mini-nav active"><i /><b /></span>
            <span class="mini-nav"><i /><b /></span>
            <span class="mini-nav"><i /><b /></span>
            <span class="mini-avatar" />
          </div>
          <div class="mini-content">
            <div class="mini-message"><span /><span /></div>
            <div class="mini-response"><i /><span /><span /><span /></div>
            <div class="mini-composer"><span /><i /></div>
          </div>
        </div>
      </div>
      <div class="flex items-center gap-2 px-1.5 pb-1 pt-2.5 text-[13px] font-medium">
        <component :is="option.icon" :size="14" :stroke-width="1.75" class="shrink-0 text-ui-text-muted" aria-hidden="true" />
        <span class="truncate">{{ t(option.label) }}</span>
        <span class="theme-check ml-auto flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-ui-border-strong">
          <Check v-if="modelValue === option.value" :size="11" :stroke-width="2.5" aria-hidden="true" />
        </span>
      </div>
    </RadioGroupItem>
  </RadioGroupRoot>
</template>

<style scoped>
.theme-option[data-state="checked"] .theme-check { border-color: var(--ui-color-accent); background: var(--ui-color-accent); color: var(--ui-color-canvas); }
.theme-picture { position: relative; height: 112px; overflow: hidden; border: 1px solid var(--ui-color-border); border-radius: 8px; }
.mini-app {
  --mini-canvas: #fbfbfd; --mini-sidebar: #f0f1f6; --mini-surface: #ffffff;
  --mini-line: #c3c8d7; --mini-border: #e3e6ed; --mini-accent: #6674df; --mini-bubble: #e8ebfc;
  position: absolute; inset: 0; display: grid; grid-template: 19px 1fr / 28% 1fr;
  background: var(--mini-canvas);
}
.mini-app[data-palette="dark"] {
  --mini-canvas: #191b23; --mini-sidebar: #13151c; --mini-surface: #262a35;
  --mini-line: #50576c; --mini-border: #303443; --mini-accent: #97a3ff; --mini-bubble: #313753;
}
[data-mode="system"] .mini-app[data-palette="dark"] { clip-path: polygon(50% 0, 100% 0, 100% 100%, 50% 100%); }
.mini-titlebar { grid-column: 1 / -1; display: flex; align-items: center; gap: 3px; padding: 0 7px; border-bottom: 1px solid var(--mini-border); }
.mini-titlebar i { width: 4px; height: 4px; border-radius: 50%; background: var(--mini-line); }
.mini-titlebar span { width: 28px; height: 3px; margin-left: auto; border-radius: 2px; background: var(--mini-border); }
.mini-sidebar { position: relative; display: flex; flex-direction: column; gap: 5px; padding: 8px 5px; background: var(--mini-sidebar); border-right: 1px solid var(--mini-border); }
.mini-brand, .mini-nav { display: flex; align-items: center; gap: 4px; height: 9px; padding: 2px 3px; border-radius: 3px; }
.mini-brand { margin-bottom: 3px; }
.mini-brand i { width: 6px; height: 6px; border-radius: 2px; background: var(--mini-accent); }
.mini-brand b { width: 70%; height: 3px; border-radius: 2px; background: var(--mini-line); }
.mini-nav.active { background: var(--mini-bubble); }
.mini-nav i { width: 4px; height: 4px; border-radius: 1px; background: var(--mini-line); }
.mini-nav b { width: 60%; height: 2px; border-radius: 2px; background: var(--mini-line); }
.mini-nav.active :is(i, b) { background: var(--mini-accent); }
.mini-avatar { position: absolute; bottom: 7px; left: 8px; width: 7px; height: 7px; border-radius: 50%; background: var(--mini-line); }
.mini-content { position: relative; padding: 9px 9px 26px; }
.mini-message { width: 70%; margin-left: auto; padding: 6px; border-radius: 5px 5px 1px 5px; background: var(--mini-bubble); }
.mini-message span, .mini-response span { display: block; height: 3px; border-radius: 2px; background: var(--mini-line); }
.mini-message span + span { width: 65%; margin-top: 4px; }
.mini-response { position: relative; margin-top: 9px; padding-left: 11px; }
.mini-response i { position: absolute; top: 0; left: 0; width: 6px; height: 6px; border-radius: 2px; background: var(--mini-accent); }
.mini-response span { margin-bottom: 4px; }
.mini-response span:last-child { width: 55%; }
.mini-composer { position: absolute; right: 8px; bottom: 7px; left: 8px; display: flex; align-items: center; justify-content: space-between; height: 16px; padding: 4px 5px; border: 1px solid var(--mini-border); border-radius: 4px; background: var(--mini-surface); }
.mini-composer span { width: 40%; height: 2px; background: var(--mini-line); }
.mini-composer i { width: 7px; height: 7px; border-radius: 2px; background: var(--mini-accent); }
@media (max-width: 1050px) { .theme-picture { height: 94px; } }
</style>
