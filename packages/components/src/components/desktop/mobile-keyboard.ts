import { MAX_DESKTOP_CLIPBOARD_BYTES, type DesktopInputMessage } from "../../../../client/src/desktop-input.ts"

type Sender = (message: DesktopInputMessage) => boolean

/** One-shot modifiers never stay pressed while a mobile user chooses the next key. */
export function sendDesktopKey(send: Sender, code: string, modifiers: readonly string[] = []): void {
  const codes = [...modifiers, code]
  for (const entry of codes) {
    if (!send({ type: "key", code: entry, pressed: true, repeat: false })) {
      send({ type: "releaseAll" })
      return
    }
  }
  for (const entry of codes.reverse()) send({ type: "key", code: entry, pressed: false, repeat: false })
}

/** Explicit IME commits use the ordered clipboard + paste path, including Unicode. */
export function sendDesktopText(send: Sender, raw: string, platform: string, pasteShift = false): void {
  const text = raw.replaceAll("\0", "")
  if (!text || new TextEncoder().encode(text).byteLength > MAX_DESKTOP_CLIPBOARD_BYTES) return
  if (!send({ type: "releaseAll" }) || !send({ type: "clipboard", text })) return
  sendDesktopKey(send, "KeyV", [platform === "darwin" ? "MetaLeft" : "ControlLeft", ...(pasteShift ? ["ShiftLeft"] : [])])
}

export function textKey(text: string): string | undefined {
  if (/^[a-z]$/i.test(text)) return `Key${text.toUpperCase()}`
  if (/^[0-9]$/.test(text)) return `Digit${text}`
  return ({ " ": "Space", "[": "BracketLeft", "]": "BracketRight", "\\": "Backslash", "/": "Slash", ".": "Period", ",": "Comma", "-": "Minus", "=": "Equal", "`": "Backquote", ";": "Semicolon", "'": "Quote" } as Record<string, string>)[text]
}
