import { ClipboardAddon } from "@xterm/addon-clipboard"
import { ProgressAddon, type IProgressState } from "@xterm/addon-progress"
import { SerializeAddon } from "@xterm/addon-serialize"
import { Unicode11Addon } from "@xterm/addon-unicode11"
import { WebLinksAddon } from "@xterm/addon-web-links"
import type { Terminal } from "@xterm/xterm"
import { onBeforeUnmount, ref, shallowRef, watch } from "vue"

/** Browser and OSC 8 links use the same external-link policy as the desktop host. */
function openTerminalLink(event: MouseEvent, uri: string): void {
  event.preventDefault()
  let target: URL
  try { target = new URL(uri) }
  catch { return }
  if (target.protocol === "https:" || target.protocol === "http:") {
    window.open(target.href, "_blank", "noopener,noreferrer")
  }
}

/** Each surface owns its addons; xterm disposes them with the terminal. */
export function useTerminalAddons(terminal: Terminal, interactive: () => boolean) {
  const progressAddon = new ProgressAddon()
  const serializeAddon = new SerializeAddon()
  const progress = shallowRef<IProgressState>({ state: 0, value: 0 })
  const pendingClipboard = ref<string | null>(null)

  terminal.loadAddon(new Unicode11Addon())
  terminal.unicode.activeVersion = "11"
  terminal.options.linkHandler = { activate: openTerminalLink }
  terminal.loadAddon(new WebLinksAddon(openTerminalLink))
  terminal.loadAddon(serializeAddon)
  terminal.loadAddon(progressAddon)
  const progressListener = progressAddon.onChange(value => { progress.value = value })
  terminal.loadAddon(new ClipboardAddon(undefined, {
    // Remote output cannot read the local clipboard. The empty reply keeps OSC 52 queries responsive.
    readText: () => "",
    // Copying requires a local button click; replay and read-only output cannot stage a request.
    writeText: (_selection, text) => { if (interactive()) pendingClipboard.value = text },
  }))

  watch(interactive, enabled => { if (!enabled) pendingClipboard.value = null }, { flush: "sync" })
  onBeforeUnmount(() => { progressListener.dispose() })

  return {
    progress,
    pendingClipboard,
    reset(): void {
      progressAddon.progress = { state: 0, value: 0 }
      pendingClipboard.value = null
    },
    serialize(format: "ansi" | "html"): string {
      if (format === "ansi") return serializeAddon.serialize({ excludeModes: true, excludeAltBuffer: true })
      // The addon supplies clipboard HTML; a downloaded document also needs its encoding.
      return '<!doctype html>\n' + serializeAddon.serializeAsHTML({ includeGlobalBackground: true })
        .replace("<html>", '<html><head><meta charset="utf-8"></head>')
    },
  }
}
