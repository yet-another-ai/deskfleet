export const TERMINAL_COLOR_KEYS = [
  "background", "foreground", "cursor", "selectionBackground",
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const

export type TerminalColorKey = typeof TERMINAL_COLOR_KEYS[number]
export type TerminalColors = Record<TerminalColorKey, string>

export const TERMINAL_THEME_PRESETS = [
  {
    id: "deskfleet", label: "DeskFleet",
    // Preserve the original surface colors and xterm.js's default ANSI palette.
    colors: {
      background: "#15171d", foreground: "#e3e6ee", cursor: "#e3e6ee", selectionBackground: "#3a3f4c",
      black: "#2e3436", red: "#cc0000", green: "#4e9a06", yellow: "#c4a000",
      blue: "#3465a4", magenta: "#75507b", cyan: "#06989a", white: "#d3d7cf",
      brightBlack: "#555753", brightRed: "#ef2929", brightGreen: "#8ae234", brightYellow: "#fce94f",
      brightBlue: "#729fcf", brightMagenta: "#ad7fa8", brightCyan: "#34e2e2", brightWhite: "#eeeeec",
    },
  },
  {
    id: "dracula", label: "Dracula",
    // https://spec.draculatheme.com/#sec-ANSI
    colors: {
      background: "#282a36", foreground: "#f8f8f2", cursor: "#f8f8f2", selectionBackground: "#44475a",
      black: "#21222c", red: "#ff5555", green: "#50fa7b", yellow: "#f1fa8c",
      blue: "#bd93f9", magenta: "#ff79c6", cyan: "#8be9fd", white: "#f8f8f2",
      brightBlack: "#6272a4", brightRed: "#ff6e6e", brightGreen: "#69ff94", brightYellow: "#ffffa5",
      brightBlue: "#d6acff", brightMagenta: "#ff92df", brightCyan: "#a4ffff", brightWhite: "#ffffff",
    },
  },
  {
    id: "one-dark", label: "One Dark",
    // Terminal adaptation of https://github.com/atom/one-dark-syntax/blob/master/styles/colors.less
    colors: {
      background: "#282c34", foreground: "#abb2bf", cursor: "#528bff", selectionBackground: "#3e4451",
      black: "#282c34", red: "#e06c75", green: "#98c379", yellow: "#e5c07b",
      blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#abb2bf",
      brightBlack: "#5c6370", brightRed: "#e06c75", brightGreen: "#98c379", brightYellow: "#e5c07b",
      brightBlue: "#61afef", brightMagenta: "#c678dd", brightCyan: "#56b6c2", brightWhite: "#ffffff",
    },
  },
  {
    id: "nord", label: "Nord",
    // https://www.nordtheme.com/docs/colors-and-palettes/
    colors: {
      background: "#2e3440", foreground: "#d8dee9", cursor: "#d8dee9", selectionBackground: "#434c5e",
      black: "#3b4252", red: "#bf616a", green: "#a3be8c", yellow: "#ebcb8b",
      blue: "#81a1c1", magenta: "#b48ead", cyan: "#88c0d0", white: "#e5e9f0",
      brightBlack: "#4c566a", brightRed: "#bf616a", brightGreen: "#a3be8c", brightYellow: "#ebcb8b",
      brightBlue: "#81a1c1", brightMagenta: "#b48ead", brightCyan: "#8fbcbb", brightWhite: "#eceff4",
    },
  },
  {
    id: "solarized-light", label: "Solarized Light",
    // https://github.com/altercation/solarized/blob/master/xresources/solarized (light variant)
    colors: {
      background: "#fdf6e3", foreground: "#657b83", cursor: "#586e75", selectionBackground: "#eee8d5",
      black: "#eee8d5", red: "#dc322f", green: "#859900", yellow: "#b58900",
      blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198", white: "#073642",
      brightBlack: "#fdf6e3", brightRed: "#cb4b16", brightGreen: "#93a1a1", brightYellow: "#839496",
      brightBlue: "#657b83", brightMagenta: "#6c71c4", brightCyan: "#586e75", brightWhite: "#002b36",
    },
  },
] as const satisfies readonly { id: string; label: string; colors: TerminalColors }[]

export type TerminalThemeId = typeof TERMINAL_THEME_PRESETS[number]["id"]

export function isTerminalThemeId(value: unknown): value is TerminalThemeId {
  return TERMINAL_THEME_PRESETS.some(preset => preset.id === value)
}

/** A fresh object keeps renderer changes from mutating saved presets or overrides. */
export function resolveTerminalTheme(theme: TerminalThemeId, overrides: Partial<TerminalColors> = {}): TerminalColors {
  const preset = TERMINAL_THEME_PRESETS.find(preset => preset.id === theme) ?? TERMINAL_THEME_PRESETS[0]
  return { ...preset.colors, ...overrides }
}

export function validateTerminalColors(value: unknown): Partial<TerminalColors> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid terminal colors")
  const colors: Partial<TerminalColors> = {}
  for (const [key, color] of Object.entries(value)) {
    if (!TERMINAL_COLOR_KEYS.includes(key as TerminalColorKey)
      || typeof color !== "string" || !/^#[\da-f]{6}$/i.test(color)) {
      throw new Error("Invalid terminal colors")
    }
    colors[key as TerminalColorKey] = color.toLowerCase()
  }
  return colors
}
