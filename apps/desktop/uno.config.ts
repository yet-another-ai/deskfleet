import { defineConfig, presetMini } from "unocss"

const colorNames = [
  "canvas",
  "sidebar",
  "surface",
  "text",
  "text-muted",
  "text-faint",
  "border",
  "hover",
  "active",
  "badge",
  "accent",
  "action",
  "action-text",
  "action-disabled",
  "avatar",
  "focus",
  "success",
  "warning",
  "danger",
  "terminal",
] as const

export default defineConfig({
  presets: [presetMini()],
  theme: {
    fontFamily: { mono: "var(--ui-font-mono)" },
    colors: Object.fromEntries(colorNames.map((name) => [`ui-${name}`, `var(--ui-color-${name})`])),
    boxShadow: { "ui-card": "var(--ui-shadow-card)" },
  },
  shortcuts: {
    "ui-badge": "rounded-md bg-ui-badge px-1.5 text-xs leading-5",
    "ui-section-title": "m-0 mb-2 text-[13px] font-medium text-ui-text-muted",
    "ui-card": "overflow-hidden rounded-xl border border-ui-border bg-ui-surface",
    "ui-card-row": "flex min-h-11 items-center gap-3 px-4 py-2",
    "ui-text-button":
      "app-no-drag inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] text-ui-text-muted",
  },
  rules: [
    // Frameless windows move by dragging these regions; controls inside opt out.
    ["app-drag", { "app-region": "drag", "-webkit-app-region": "drag" }],
    ["app-no-drag", { "app-region": "no-drag", "-webkit-app-region": "no-drag" }],
  ],
})
