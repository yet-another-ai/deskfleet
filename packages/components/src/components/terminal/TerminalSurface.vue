<script setup lang="ts">
import { FitAddon } from "@xterm/addon-fit"
import { LigaturesAddon } from "@xterm/addon-ligatures"
import { Terminal, type ITheme } from "@xterm/xterm"
import "@xterm/xterm/css/xterm.css"
import { useResizeObserver } from "@vueuse/core"
import { storeToRefs } from "pinia"
import { computed, onBeforeUnmount, onMounted, useTemplateRef, watch } from "vue"
import { DEFAULT_TERMINAL_FONT } from "@deskfleet/client/appearance"
import { useAppearanceStore } from "../../stores/appearance.ts"

const props = withDefaults(defineProps<{
  /** Written once when the terminal opens; `\n` becomes a new line. */
  banner?: string
  interactive?: boolean
  scrollback?: number
  /** Preview overrides; omitted values use the saved appearance. */
  fontFamily?: string
  ligatures?: boolean
}>(), { ligatures: undefined })
const emit = defineEmits<{
  ready: [size: { cols: number; rows: number }]
  input: [data: string]
  resize: [size: { cols: number; rows: number }]
  /** The title the shell or running program sets with OSC 0 or 2. */
  title: [title: string]
}>()

// Terminals stay dark in both themes; the background matches --ui-color-terminal.
const theme: ITheme = {
  background: "#15171d",
  foreground: "#e3e6ee",
  cursor: "#e3e6ee",
  selectionBackground: "#3a3f4c",
}

const container = useTemplateRef<HTMLDivElement>("container")
const { terminalFont, terminalLigatures } = storeToRefs(useAppearanceStore())
const fontFamily = computed(() => props.fontFamily === undefined ? terminalFont.value : props.fontFamily.trim() || DEFAULT_TERMINAL_FONT)
const ligatures = computed(() => props.ligatures ?? terminalLigatures.value)
const fit = new FitAddon()
const terminal = new Terminal({
  // The official ligatures addon uses the character-joiner API.
  allowProposedApi: true,
  cursorBlink: props.interactive ?? false,
  disableStdin: !props.interactive,
  fontFamily: fontFamily.value,
  fontSize: 13,
  scrollback: props.scrollback ?? 5_000,
  theme,
})
terminal.loadAddon(fit)
let ligaturesAddon: LigaturesAddon | undefined
function updateLigatures(): void {
  if (!terminal.element) return
  if (ligatures.value && !ligaturesAddon) {
    ligaturesAddon = new LigaturesAddon({ fontFeatureSettings: '"calt" on, "liga" on' })
    terminal.loadAddon(ligaturesAddon)
  } else if (!ligatures.value && ligaturesAddon) {
    ligaturesAddon.dispose()
    ligaturesAddon = undefined
  }
  // DOM rows also merge ordinary characters into spans, so disable browser shaping explicitly.
  if (!ligatures.value) terminal.element.style.fontFeatureSettings = '"calt" off, "liga" off'
  terminal.refresh(0, terminal.rows - 1)
}
const input = terminal.onData((data) => { if (props.interactive) emit("input", data) })
const resize = terminal.onResize((size) => emit("resize", size))
const title = terminal.onTitleChange((value) => emit("title", value))
watch(() => props.interactive, (interactive) => {
  terminal.options.disableStdin = !interactive
  terminal.options.cursorBlink = interactive ?? false
  if (interactive) terminal.focus()
})
watch(() => props.scrollback, (scrollback) => { terminal.options.scrollback = scrollback ?? 5_000 })
watch(fontFamily, (fontFamily) => {
  terminal.options.fontFamily = fontFamily
  if (container.value) fit.fit()
})
watch(ligatures, updateLigatures)

onMounted(() => {
  terminal.open(container.value!)
  updateLigatures()
  fit.fit()
  if (props.banner && !props.interactive) terminal.write("\x1b[?25l")
  if (props.banner) terminal.write(props.banner.replaceAll("\n", "\r\n"))
  emit("ready", { cols: terminal.cols, rows: terminal.rows })
})
useResizeObserver(container, () => fit.fit())
onBeforeUnmount(() => { input.dispose(); resize.dispose(); title.dispose(); terminal.dispose() })

defineExpose({
  terminal,
  write: (data: Uint8Array, callback?: () => void) => terminal.write(data, callback),
  reset: () => terminal.reset(),
  focus: () => terminal.focus(),
})
</script>

<template>
  <div ref="container" class="h-full min-h-0 w-full" />
</template>
