<script setup lang="ts">
import { Code, Keyboard, MousePointer2, Touchpad } from "@lucide/vue"
import { useEventListener } from "@vueuse/core"
import { ref, useTemplateRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { DesktopInputMessage } from "@deskfleet/client/desktop-input"
import type { DesktopPointerMode } from "../../composables/useDesktopTouch.ts"
import UiButton from "../common/UiButton.vue"
import UiCheckbox from "../common/UiCheckbox.vue"
import { sendDesktopKey, sendDesktopText, textKey } from "./mobile-keyboard.ts"

const props = defineProps<{ enabled: boolean; stage: HTMLElement | null; platform: string; send: (message: DesktopInputMessage) => boolean }>()
const mode = defineModel<DesktopPointerMode>({ required: true })
const { t } = useI18n()
const editor = useTemplateRef<HTMLTextAreaElement>("editor")
const hacker = ref(false)
const keyboard = ref(false)
const terminalPaste = ref(false)
const modifiers = ref<string[]>([])
let composing = false
const sentinel = "\u200b"
const modifierKeys = [["Ctrl", "ControlLeft"], ["Alt", "AltLeft"], ["Shift", "ShiftLeft"], ["Meta", "MetaLeft"]] as const
const rows = [
  [["Esc", "Escape"], ["Tab", "Tab"], ["Home", "Home"], ["End", "End"], ["PgUp", "PageUp"], ["PgDn", "PageDown"]],
  [["←", "ArrowLeft"], ["↑", "ArrowUp"], ["↓", "ArrowDown"], ["→", "ArrowRight"], ["⌫", "Backspace"], ["Del", "Delete"], ["↵", "Enter"]],
  Array.from({ length: 12 }, (_, index) => [`F${index + 1}`, `F${index + 1}`]),
  ["A", "C", "V", "X", "Z", "R", "L", "D"].map(letter => [letter, `Key${letter}`]),
]

function key(code: string): void {
  if (!props.enabled) return
  sendDesktopKey(props.send, code, modifiers.value)
  modifiers.value = []
}
function modifier(code: string): void {
  modifiers.value = modifiers.value.includes(code) ? modifiers.value.filter(value => value !== code) : [...modifiers.value, code]
}
function toggleKeyboard(): void {
  if (keyboard.value) { editor.value?.blur(); return }
  if (!props.enabled || !editor.value) return
  editor.value.value = sentinel
  // Keep focus in the user gesture so iOS can open its system keyboard.
  editor.value.focus({ preventScroll: true })
  editor.value.setSelectionRange(sentinel.length, sentinel.length)
}
function input(): void {
  if (composing || !editor.value) return
  const text = editor.value.value.replaceAll(sentinel, "")
  editor.value.value = sentinel
  if (!props.enabled || !text) return
  const code = textKey(text)
  if (modifiers.value.length && code) key(code)
  else { modifiers.value = []; sendDesktopText(props.send, text, props.platform, terminalPaste.value && props.platform !== "darwin") }
}
function beforeInput(event: InputEvent): void {
  if (composing || event.isComposing) return
  const code = ({ deleteContentBackward: "Backspace", deleteContentForward: "Delete", insertLineBreak: "Enter", insertParagraph: "Enter" } as Record<string, string>)[event.inputType]
  if (code) { event.preventDefault(); key(code) }
}
function keyDown(event: KeyboardEvent): void {
  if (event.isComposing || composing) return
  if (["Backspace", "Delete", "Enter", "Tab", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.code)) {
    event.preventDefault(); key(event.code)
  }
}
function reset(): void {
  modifiers.value = []; composing = false; hacker.value = false
  editor.value?.blur()
  if (editor.value) editor.value.value = sentinel
}
watch(() => props.enabled, enabled => { if (!enabled) reset() }, { flush: "sync" })
useEventListener(window, "blur", reset)
useEventListener(document, "visibilitychange", () => { if (document.hidden) reset() })
</script>

<template>
  <div class="flex flex-wrap items-center gap-1" data-desktop-mobile-controls>
    <UiButton variant="ghost" class="min-h-11" :disabled="!enabled" :aria-label="t(mode === 'absolute' ? 'desktop.absoluteMouse' : 'desktop.relativeMouse')" :aria-pressed="mode === 'relative'" data-desktop-pointer-mode @click="mode = mode === 'absolute' ? 'relative' : 'absolute'">
      <component :is="mode === 'absolute' ? MousePointer2 : Touchpad" :size="18" aria-hidden="true" />
      {{ t(mode === 'absolute' ? 'desktop.absoluteMouse' : 'desktop.relativeMouse') }}
    </UiButton>
    <UiButton variant="ghost" size="icon" class="min-h-11 min-w-11" :portal-to="stage ?? undefined" :disabled="!enabled" :label="t('desktop.systemKeyboard')" :aria-pressed="keyboard" data-desktop-system-keyboard @pointerdown.prevent @click="toggleKeyboard"><Keyboard :size="18" aria-hidden="true" /></UiButton>
    <UiButton variant="ghost" size="icon" class="min-h-11 min-w-11" :portal-to="stage ?? undefined" :disabled="!enabled" :label="t('desktop.hackerKeyboard')" :aria-pressed="hacker" data-desktop-hacker-keyboard @pointerdown.prevent @click="hacker = !hacker"><Code :size="18" aria-hidden="true" /></UiButton>
    <Teleport v-if="stage" :to="stage">
      <textarea ref="editor" class="absolute bottom-0 left-0 h-px w-px resize-none opacity-0" style="font-size: 16px" :aria-label="t('desktop.systemKeyboard')" :disabled="!enabled" tabindex="-1" autocapitalize="off" autocomplete="off" :spellcheck="false" autocorrect="off" @focus="keyboard = true" @blur="keyboard = false" @keydown.stop="keyDown" @keyup.stop @beforeinput="beforeInput" @input="input" @compositionstart="composing = true" @compositionend="composing = false; input()" />
      <div v-if="hacker && enabled" role="group" :aria-label="t('desktop.hackerKeyboard')" class="absolute bottom-3 left-3 right-3 z-20 max-h-[50%] overflow-auto rounded-xl border border-ui-border bg-ui-surface p-2 shadow-ui-popover" data-desktop-key-panel @mousedown.prevent>
        <div class="mb-2 flex items-center justify-between gap-2 text-xs text-ui-text-muted">
          <span>{{ t('desktop.hackerKeyboard') }}</span>
          <UiButton size="sm" @click="hacker = false">{{ t('desktop.hideKeyboard') }}</UiButton>
        </div>
        <div class="mb-1 flex flex-wrap gap-1">
          <UiButton v-for="[label, code] in modifierKeys" :key="code" :variant="modifiers.includes(code) ? 'primary' : 'default'" class="min-h-11 min-w-11 flex-1" :aria-pressed="modifiers.includes(code)" @click="modifier(code)">{{ label }}</UiButton>
        </div>
        <div v-for="(row, index) in rows" :key="index" class="mb-1 flex flex-wrap gap-1">
          <UiButton v-for="[label, code] in row" :key="code" class="min-h-11 min-w-9 flex-1" @click="key(code!)">{{ label }}</UiButton>
        </div>
        <p class="m-0 pt-1 text-xs text-ui-text-muted">{{ t('desktop.mobileKeyboardHint') }}</p>
        <label v-if="platform !== 'darwin'" class="mt-2 flex min-h-11 items-center gap-2 text-xs">
          <UiCheckbox v-model="terminalPaste" />{{ t('desktop.terminalPaste') }}
        </label>
      </div>
    </Teleport>
  </div>
</template>
