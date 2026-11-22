const CURSOR_LETTERS: Record<string, string | undefined> = {
  ArrowUp: "A",
  ArrowDown: "B",
  ArrowRight: "C",
  ArrowLeft: "D",
  Home: "H",
  End: "F",
}
const PUNCTUATION: Record<string, string | undefined> = {
  Space: "  ", Backquote: "`~", Minus: "-_", Equal: "=+", BracketLeft: "[{", BracketRight: "]}",
  Backslash: "\\|", Semicolon: ";:", Quote: "'\"", Comma: ",<", Period: ".>", Slash: "/?",
}
const F_KEY_TILDE_CODES = [15, 17, 18, 19, 20, 21, 23, 24] as const

export function ctrlChar(ch: string): string {
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

export function csiCursor(letter: string, ctrlActive: boolean, altActive: boolean, appCursor: boolean, shift = false): string {
  if (altActive && !ctrlActive && !shift && (letter === "D" || letter === "C")) {
    return letter === "D" ? "\x1bb" : "\x1bf"
  }
  const mod = 1 + Number(shift) + (altActive ? 2 : 0) + (ctrlActive ? 4 : 0)
  if (mod > 1) return `\x1b[1;${mod}${letter}`
  return appCursor ? `\x1bO${letter}` : `\x1b[${letter}`
}

function csiTilde(code: number, ctrlActive: boolean, altActive: boolean, shift: boolean): string {
  const mod = 1 + Number(shift) + (altActive ? 2 : 0) + (ctrlActive ? 4 : 0)
  return mod > 1 ? `\x1b[${code};${mod}~` : `\x1b[${code}~`
}

export function encodeKey(keyId: string, ctrlActive: boolean, altActive: boolean, appCursor: boolean, shift = false): string {
  if (keyId === "Escape") return altActive ? "\x1b\x1b" : "\x1b"
  if (keyId === "Tab" && shift) return "\x1b[Z"
  if (keyId === "Tab") return altActive ? "\x1b\t" : "\t"
  if (keyId === "Backspace") return (altActive ? "\x1b" : "") + (ctrlActive ? "\b" : "\x7f")
  if (keyId === "Enter") return altActive ? "\x1b\r" : "\r"
  if (keyId === "Insert") return csiTilde(2, ctrlActive, altActive, shift)
  if (keyId === "Delete") return csiTilde(3, ctrlActive, altActive, shift)
  const cursorLetter = CURSOR_LETTERS[keyId]
  if (cursorLetter) return csiCursor(cursorLetter, ctrlActive, altActive, appCursor, shift)
  if (keyId === "PageUp") return csiTilde(5, ctrlActive, altActive, shift)
  if (keyId === "PageDown") return csiTilde(6, ctrlActive, altActive, shift)
  if (keyId.startsWith("F") && keyId.length > 1) {
    const index = Number(keyId.slice(1))
    if (index >= 1 && index <= 4) {
      const letter = ["P", "Q", "R", "S"][index - 1]!
      const mod = 1 + Number(shift) + (altActive ? 2 : 0) + (ctrlActive ? 4 : 0)
      return mod > 1 ? `\x1b[1;${mod}${letter}` : `\x1bO${letter}`
    }
    if (index >= 5 && index <= 12) {
      return csiTilde(F_KEY_TILDE_CODES[index - 5]!, ctrlActive, altActive, shift)
    }
  }
  const ch = ctrlActive ? ctrlChar(keyId) : keyId
  return altActive ? `\x1b${ch}` : ch
}

/** WKWebView can report 0, 13, or 229 as the legacy keyCode for an iPad
 * hardware shortcut. Use its logical key before xterm 6's keyCode-based decoder. */
export function ipadKey(event: KeyboardEvent): string {
  let key = event.key
  if (key.startsWith("UIKeyInput")) key = key.slice("UIKeyInput".length).replace(/^(Up|Down|Left|Right)Arrow$/, "Arrow$1")
  if (event.code && (!key || key === "Unidentified" || key === "Process" || key.charCodeAt(0) < 32)) key = event.code
  // Option can supply an already-translated character (e.g. Option+B = ∫).
  if (event.altKey && key.length === 1 && key.charCodeAt(0) > 127) key = event.code
  if (/^Key[A-Z]$/.test(key)) key = event.shiftKey ? key.slice(3) : key.slice(3).toLowerCase()
  else if (/^Digit[0-9]$/.test(key)) key = key.slice(5)
  else if (Object.hasOwn(PUNCTUATION, key)) key = PUNCTUATION[key]![Number(event.shiftKey)]!
  return key
}

export function ipadShortcut(event: KeyboardEvent, key: string, appCursor: boolean): string | undefined {
  if (event.metaKey) return

  if (key.length === 1 && (event.ctrlKey || event.altKey)) {
    if (key.charCodeAt(0) > 127) return
    const ch = event.ctrlKey ? ctrlChar(key) : key
    if (event.ctrlKey && !event.altKey && ch === key) return
    return event.altKey ? "\x1b" + ch : ch
  }
  // Keep xterm's normal navigation and scrollback shortcuts when its legacy
  // keycode is available. WKWebView's unidentified navigation events need encoding.
  if (event.keyCode !== 0 && event.keyCode !== 229) return
  if (!Object.hasOwn(CURSOR_LETTERS, key) && !/^(Escape|Tab|Backspace|Enter|Insert|Delete|PageUp|PageDown|F(?:[1-9]|1[0-2]))$/.test(key)) return
  return encodeKey(key, event.ctrlKey, event.altKey, appCursor, event.shiftKey)
}
