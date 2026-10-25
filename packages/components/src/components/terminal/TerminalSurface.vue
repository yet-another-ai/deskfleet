<script setup lang="ts">
import { FitAddon } from "@xterm/addon-fit"
import { Terminal, type ITheme } from "@xterm/xterm"
import "@xterm/xterm/css/xterm.css"
import { useResizeObserver } from "@vueuse/core"
import { onBeforeUnmount, onMounted, useTemplateRef, watch } from "vue"

const props = defineProps<{
  /** Written once when the terminal opens; `\n` becomes a new line. */
  banner?: string
  interactive?: boolean
  scrollback?: number
}>()
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
const fit = new FitAddon()
const terminal = new Terminal({
  cursorBlink: props.interactive ?? false,
  disableStdin: !props.interactive,
  fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  fontSize: 13,
  scrollback: props.scrollback ?? 5_000,
  theme,
})
terminal.loadAddon(fit)
const input = terminal.onData((data) => emit("input", data))
const resize = terminal.onResize((size) => emit("resize", size))
const title = terminal.onTitleChange((value) => emit("title", value))
watch(() => props.interactive, (interactive) => {
  terminal.options.disableStdin = !interactive
  terminal.options.cursorBlink = interactive ?? false
  if (interactive) terminal.focus()
})
watch(() => props.scrollback, (scrollback) => { terminal.options.scrollback = scrollback ?? 5_000 })

onMounted(() => {
  terminal.open(container.value!)
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
