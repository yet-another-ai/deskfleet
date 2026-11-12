<script setup lang="ts">
import { ChevronDown, ChevronUp } from "@lucide/vue"
import { useIntervalFn, useTimeoutFn } from "@vueuse/core"
import type { Terminal } from "@xterm/xterm"
import { onBeforeUnmount, ref } from "vue"
import { useI18n } from "vue-i18n"

export type ModifierState = "off" | "armed" | "locked"

interface KeySpec {
  id: string
  label: string
  ariaKey?: string
  repeatable?: boolean
}

const props = defineProps<{ terminal: Terminal }>()
const { t } = useI18n()

const ctrl = ref<ModifierState>("off")
const alt = ref<ModifierState>("off")
const expanded = ref(false)
const activeRepeatKey = ref<string | null>(null)
let repeated = false
let sendingVirtualKey = false

const leadKeys: KeySpec[] = [
  { id: "Escape", label: "Esc", ariaKey: "terminal.keyEsc" },
  { id: "Tab", label: "Tab", ariaKey: "terminal.keyTab" },
]
const arrowKeys: KeySpec[] = [
  { id: "ArrowLeft", label: "←", ariaKey: "terminal.keyLeft", repeatable: true },
  { id: "ArrowDown", label: "↓", ariaKey: "terminal.keyDown", repeatable: true },
  { id: "ArrowUp", label: "↑", ariaKey: "terminal.keyUp", repeatable: true },
  { id: "ArrowRight", label: "→", ariaKey: "terminal.keyRight", repeatable: true },
]
const navAndSymbolKeys: KeySpec[] = [
  { id: "Home", label: "Home", ariaKey: "terminal.keyHome" },
  { id: "End", label: "End", ariaKey: "terminal.keyEnd" },
  { id: "PageUp", label: "PgUp", ariaKey: "terminal.keyPgUp", repeatable: true },
  { id: "PageDown", label: "PgDn", ariaKey: "terminal.keyPgDn", repeatable: true },
  { id: "|", label: "|" },
  { id: "/", label: "/" },
  { id: "-", label: "-" },
  { id: "~", label: "~" },
  { id: "_", label: "_" },
  { id: "*", label: "*" },
]
const functionKeys: KeySpec[] = Array.from({ length: 12 }, (_, index) => {
  const label = `F${index + 1}`
  return { id: label, label }
})

const CURSOR_LETTERS: Record<string, string | undefined> = {
  ArrowUp: "A",
  ArrowDown: "B",
  ArrowRight: "C",
  ArrowLeft: "D",
  Home: "H",
  End: "F",
}
const F_KEY_TILDE_CODES = [15, 17, 18, 19, 20, 21, 23, 24] as const

function ctrlChar(ch: string): string {
  const code = ch.charCodeAt(0)
  if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) return String.fromCharCode(code & 0x1f)
  switch (ch) {
    case "@":
    case " ":
    case "2":
      return "\x00"
    case "[":
    case "3":
      return "\x1b"
    case "\\":
    case "|":
    case "4":
      return "\x1c"
    case "]":
    case "5":
      return "\x1d"
    case "^":
    case "~":
    case "6":
      return "\x1e"
    case "_":
    case "-":
    case "/":
    case "7":
      return "\x1f"
    case "?":
    case "8":
      return "\x7f"
    default:
      return ch
  }
}

function csiCursor(letter: string, ctrlActive: boolean, altActive: boolean, appCursor: boolean): string {
  if (altActive && !ctrlActive && (letter === "D" || letter === "C")) {
    return letter === "D" ? "\x1bb" : "\x1bf"
  }
  const mod = 1 + (altActive ? 2 : 0) + (ctrlActive ? 4 : 0)
  if (mod > 1) return `\x1b[1;${mod}${letter}`
  return appCursor ? `\x1bO${letter}` : `\x1b[${letter}`
}

function csiTilde(code: number, ctrlActive: boolean, altActive: boolean): string {
  const mod = 1 + (altActive ? 2 : 0) + (ctrlActive ? 4 : 0)
  return mod > 1 ? `\x1b[${code};${mod}~` : `\x1b[${code}~`
}

function encodeKey(keyId: string, ctrlActive: boolean, altActive: boolean): string {
  const appCursor = Boolean(props.terminal.modes?.applicationCursorKeysMode)
  if (keyId === "Escape") return altActive ? "\x1b\x1b" : "\x1b"
  if (keyId === "Tab") return altActive ? "\x1b\t" : "\t"
  const cursorLetter = CURSOR_LETTERS[keyId]
  if (cursorLetter) return csiCursor(cursorLetter, ctrlActive, altActive, appCursor)
  if (keyId === "PageUp") return csiTilde(5, ctrlActive, altActive)
  if (keyId === "PageDown") return csiTilde(6, ctrlActive, altActive)
  if (keyId.startsWith("F") && keyId.length > 1) {
    const index = Number(keyId.slice(1))
    if (index >= 1 && index <= 4) {
      const letter = ["P", "Q", "R", "S"][index - 1]!
      const mod = 1 + (altActive ? 2 : 0) + (ctrlActive ? 4 : 0)
      return mod > 1 ? `\x1b[1;${mod}${letter}` : `\x1bO${letter}`
    }
    if (index >= 5 && index <= 12) {
      return csiTilde(F_KEY_TILDE_CODES[index - 5]!, ctrlActive, altActive)
    }
  }
  const ch = ctrlActive ? ctrlChar(keyId) : keyId
  return altActive ? `\x1b${ch}` : ch
}

function consumeArmedModifiers(): void {
  if (ctrl.value === "armed") ctrl.value = "off"
  if (alt.value === "armed") alt.value = "off"
}

function sendKey(keyId: string): void {
  const sequence = encodeKey(keyId, ctrl.value !== "off", alt.value !== "off")
  consumeArmedModifiers()
  sendingVirtualKey = true
  try {
    props.terminal.input?.(sequence)
  } finally {
    sendingVirtualKey = false
  }
  props.terminal.focus?.()
}

function transformInput(data: string): string {
  if (sendingVirtualKey || !data || (ctrl.value === "off" && alt.value === "off")) return data
  const ctrlActive = ctrl.value !== "off"
  const altActive = alt.value !== "off"
  const cursorMatch = /^\x1b[\[O]([ABCDHF])$/u.exec(data)
  if (cursorMatch) {
    consumeArmedModifiers()
    return csiCursor(cursorMatch[1]!, ctrlActive, altActive, Boolean(props.terminal.modes?.applicationCursorKeysMode))
  }
  // Ignore multi-character payloads (paste, swipe/autocorrect words, IME commits) and non-printable/non-ASCII input.
  if (data.length !== 1) return data
  const code = data.charCodeAt(0)
  if (code < 0x20 || code > 0x7e) return data
  const modified = ctrlActive ? ctrlChar(data) : data
  if (!altActive && modified === data) return data
  consumeArmedModifiers()
  return `${altActive ? "\x1b" : ""}${modified}`
}

function toggleModifier(kind: "ctrl" | "alt"): void {
  const target = kind === "ctrl" ? ctrl : alt
  target.value = target.value === "off" ? "armed" : target.value === "armed" ? "locked" : "off"
  props.terminal.focus?.()
}

const { pause: pauseRepeat, resume: resumeRepeat } = useIntervalFn(() => {
  if (activeRepeatKey.value) sendKey(activeRepeatKey.value)
}, 65, { immediate: false })

const { start: startRepeatDelay, stop: stopRepeatDelay } = useTimeoutFn(() => {
  if (!activeRepeatKey.value) return
  repeated = true
  sendKey(activeRepeatKey.value)
  resumeRepeat()
}, 400, { immediate: false })

function stopRepeat(): void {
  stopRepeatDelay()
  pauseRepeat()
  activeRepeatKey.value = null
}

function onKeyPointerDown(key: KeySpec, event: PointerEvent): void {
  event.preventDefault()
  stopRepeat()
  repeated = false
  if (key.repeatable && event.button === 0) {
    activeRepeatKey.value = key.id
    startRepeatDelay()
  }
}

function onKeyClick(key: KeySpec): void {
  const wasRepeated = repeated
  repeated = false
  stopRepeat()
  if (!wasRepeated) sendKey(key.id)
}

function reset(): void {
  stopRepeat()
  repeated = false
  ctrl.value = "off"
  alt.value = "off"
}

onBeforeUnmount(stopRepeat)
defineExpose({ transformInput, reset })
</script>

<template>
  <div
    role="toolbar"
    :aria-label="t('terminal.keypad')"
    data-terminal-keypad
    class="flex shrink-0 select-none flex-col gap-1 border-t border-ui-border bg-ui-surface px-1.5 py-1 text-xs text-ui-text"
    @pointerdown.stop
  >
    <div v-if="expanded" data-terminal-keypad-expanded class="flex flex-col gap-1 pb-0.5">
      <div class="grid grid-cols-5 gap-1 sm:grid-cols-10">
        <button
          v-for="key in navAndSymbolKeys"
          :key="key.id"
          type="button"
          :data-key="key.id"
          :aria-label="key.ariaKey ? t(key.ariaKey) : key.label"
          class="inline-flex h-7 items-center justify-center rounded border border-ui-border bg-ui-canvas px-1 font-mono text-[11px] text-ui-text hover:bg-ui-hover active:bg-ui-active"
          @pointerdown="onKeyPointerDown(key, $event)"
          @pointerup="stopRepeat"
          @pointercancel="stopRepeat"
          @pointerleave="stopRepeat"
          @mousedown.prevent
          @click="onKeyClick(key)"
        >{{ key.label }}</button>
      </div>
      <div class="grid grid-cols-6 gap-1 sm:grid-cols-12">
        <button
          v-for="key in functionKeys"
          :key="key.id"
          type="button"
          :data-key="key.id"
          :aria-label="key.label"
          class="inline-flex h-6 items-center justify-center rounded border border-ui-border bg-ui-canvas px-1 font-mono text-[11px] text-ui-text-muted hover:bg-ui-hover hover:text-ui-text active:bg-ui-active"
          @pointerdown="onKeyPointerDown(key, $event)"
          @mousedown.prevent
          @click="onKeyClick(key)"
        >{{ key.label }}</button>
      </div>
    </div>

    <div class="grid grid-cols-9 gap-1">
      <button
        v-for="key in leadKeys"
        :key="key.id"
        type="button"
        :data-key="key.id"
        :aria-label="key.ariaKey ? t(key.ariaKey) : key.label"
        class="inline-flex h-7 items-center justify-center rounded border border-ui-border bg-ui-canvas px-1 font-mono text-[11px] font-medium text-ui-text hover:bg-ui-hover active:bg-ui-active"
        @pointerdown="onKeyPointerDown(key, $event)"
        @mousedown.prevent
        @click="onKeyClick(key)"
      >{{ key.label }}</button>

      <button
        v-for="mod in ([['ctrl', 'Ctrl', ctrl, 'terminal.keyCtrl'], ['alt', 'Alt', alt, 'terminal.keyAlt']] as const)"
        :key="mod[0]"
        type="button"
        :data-modifier="mod[0]"
        :data-modifier-state="mod[2]"
        :aria-label="t(mod[3])"
        :aria-pressed="mod[2] !== 'off'"
        class="relative inline-flex h-7 items-center justify-center rounded border px-1 font-mono text-[11px] font-medium transition-colors"
        :class="mod[2] === 'locked'
          ? 'border-ui-accent bg-ui-accent text-white'
          : mod[2] === 'armed'
            ? 'border-ui-accent bg-ui-accent/15 text-ui-accent'
            : 'border-ui-border bg-ui-canvas text-ui-text hover:bg-ui-hover active:bg-ui-active'"
        @pointerdown.prevent
        @mousedown.prevent
        @click="toggleModifier(mod[0])"
      >
        {{ mod[1] }}
        <span
          v-if="mod[2] !== 'off'"
          aria-hidden="true"
          class="absolute right-1 top-1 h-1 w-1 rounded-full"
          :class="mod[2] === 'locked' ? 'bg-current' : 'bg-ui-accent'"
        />
      </button>

      <button
        v-for="key in arrowKeys"
        :key="key.id"
        type="button"
        :data-key="key.id"
        :aria-label="key.ariaKey ? t(key.ariaKey) : key.label"
        class="inline-flex h-7 items-center justify-center rounded border border-ui-border bg-ui-canvas px-1 font-mono text-xs font-medium text-ui-text hover:bg-ui-hover active:bg-ui-active"
        @pointerdown="onKeyPointerDown(key, $event)"
        @pointerup="stopRepeat"
        @pointercancel="stopRepeat"
        @pointerleave="stopRepeat"
        @mousedown.prevent
        @click="onKeyClick(key)"
      >{{ key.label }}</button>

      <button
        type="button"
        data-keypad-expand
        :aria-expanded="expanded"
        :aria-label="t(expanded ? 'terminal.keypadCollapse' : 'terminal.keypadExpand')"
        :title="t(expanded ? 'terminal.keypadCollapse' : 'terminal.keypadExpand')"
        class="inline-flex h-7 items-center justify-center rounded border border-ui-border bg-ui-canvas text-ui-text-muted hover:bg-ui-hover hover:text-ui-text active:bg-ui-active"
        :class="expanded && 'bg-ui-active text-ui-text'"
        @pointerdown.prevent
        @mousedown.prevent
        @click="expanded = !expanded; props.terminal.focus?.()"
      ><component :is="expanded ? ChevronDown : ChevronUp" :size="14" aria-hidden="true" /></button>
    </div>
  </div>
</template>
