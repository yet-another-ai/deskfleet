<script setup lang="ts">
import { FitAddon } from "@xterm/addon-fit"
import { ImageAddon } from "@xterm/addon-image"
import { LigaturesAddon } from "@xterm/addon-ligatures"
import { WebglAddon } from "@xterm/addon-webgl"
import { Terminal, type ITheme } from "@xterm/xterm"
import "@xterm/xterm/css/xterm.css"
import { useResizeObserver } from "@vueuse/core"
import { storeToRefs } from "pinia"
import { computed, onBeforeUnmount, onMounted, useTemplateRef, watch } from "vue"
import { DEFAULT_TERMINAL_FONT } from "@deskfleet/client/appearance"
import { useAppearanceStore } from "../../stores/appearance.ts"

/** Sixel / iTerm2 inline images; size reports stay on for apps that query CSI t metrics. */
const IMAGE_ADDON_OPTIONS = {
  enableSizeReports: true,
  // 4096×4096; matches the addon default and covers large plots without unbounded decode buffers.
  pixelLimit: 16_777_216,
  // Per-surface FIFO cache (MB). Below the 128 MB default so several open tabs stay bounded.
  storageLimit: 64,
} as const

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
let webglAddon: WebglAddon | undefined
let imageAddon: ImageAddon | undefined
let ligaturesAddon: LigaturesAddon | undefined
/** `@xterm/addon-webgl@0.19.0` keeps the GL context private; dispose alone does not free it (xtermjs/xterm.js#6068). */
type WebglAddonInternals = { _renderer?: { _gl?: WebGL2RenderingContext } }
function webglRenderingContext(addon: WebglAddon): WebGL2RenderingContext | undefined {
  try {
    return (addon as unknown as WebglAddonInternals)._renderer?._gl
  } catch {
    return undefined
  }
}
/**
 * Detach the WebGL renderer and force-release its GPU context.
 * Order is dispose first, then `loseContext`, so the addon's own `webglcontextlost`
 * listener is gone before we drop the context (0.19.0 does not clear its restoration timeout).
 */
function releaseWebglRenderer(addon: WebglAddon | undefined = webglAddon): void {
  if (!addon) return
  if (webglAddon === addon) webglAddon = undefined
  const gl = webglRenderingContext(addon)
  try { addon.dispose() } catch { /* already disposed */ }
  try { gl?.getExtension("WEBGL_lose_context")?.loseContext() } catch { /* ignore host / shape changes */ }
}
/** Prefer WebGL when the environment can create a context; otherwise keep the default canvas renderer. */
function attachWebglRenderer(): void {
  let addon: WebglAddon | undefined
  try {
    addon = new WebglAddon()
    addon.onContextLoss(() => { releaseWebglRenderer(addon) })
    terminal.loadAddon(addon)
    webglAddon = addon
  } catch {
    releaseWebglRenderer(addon)
  }
}
/** Load Sixel / OSC 1337 image support after the renderer so tiles bind to the active backend. */
function attachImageAddon(): void {
  const addon = new ImageAddon({ ...IMAGE_ADDON_OPTIONS })
  terminal.loadAddon(addon)
  imageAddon = addon
}
function releaseImageAddon(): void {
  if (!imageAddon) return
  try { imageAddon.dispose() } catch { /* already disposed */ }
  imageAddon = undefined
}
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
  // LigaturesAddon binds joiners to the family active at load; recreate it when the font changes.
  if (ligaturesAddon) {
    ligaturesAddon.dispose()
    ligaturesAddon = undefined
  }
  updateLigatures()
  if (container.value) fit.fit()
})
watch(ligatures, updateLigatures)

onMounted(() => {
  terminal.open(container.value!)
  // WebGL needs the opened terminal element; attach before ligatures so joiners bind to the active renderer.
  attachWebglRenderer()
  attachImageAddon()
  updateLigatures()
  fit.fit()
  if (props.banner && !props.interactive) terminal.write("\x1b[?25l")
  if (props.banner) terminal.write(props.banner.replaceAll("\n", "\r\n"))
  emit("ready", { cols: terminal.cols, rows: terminal.rows })
})
useResizeObserver(container, () => fit.fit())
onBeforeUnmount(() => {
  // TerminalWorkspace remounts this surface on tab switches; release GPU and image caches before GC.
  releaseImageAddon()
  releaseWebglRenderer()
  input.dispose()
  resize.dispose()
  title.dispose()
  terminal.dispose()
})

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
