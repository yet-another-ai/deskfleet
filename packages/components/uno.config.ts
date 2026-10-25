import { defineConfig, presetMini } from "unocss"

const colorNames = [
  "canvas",
  "sidebar",
  "surface",
  "control",
  "control-hover",
  "text",
  "text-muted",
  "text-faint",
  "border",
  "border-strong",
  "hover",
  "active",
  "badge",
  "accent",
  "action",
  "action-hover",
  "action-text",
  "action-disabled",
  "avatar",
  "avatar-text",
  "focus",
  "success",
  "warning",
  "danger",
  "switch-thumb",
  "terminal",
] as const

// UnoCSS cannot apply opacity modifiers to a bare var(); mixing with transparent makes `bg-ui-danger/10` work.
const tokenColor = (name: string) => `color-mix(in srgb, var(--ui-color-${name}) calc(%alpha * 100%), transparent)`

// Buttons share a shape; each variant sets its colors. Utilities on the element still override the shortcut.
const button =
  "app-no-drag inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-1.5 text-[13px] font-medium leading-5 cursor-pointer transition-colors disabled:cursor-default"

export default defineConfig({
  presets: [presetMini()],
  theme: {
    fontFamily: { mono: "var(--ui-font-mono)" },
    colors: Object.fromEntries(colorNames.map((name) => [`ui-${name}`, tokenColor(name)])),
    boxShadow: {
      "ui-card": "var(--ui-shadow-card)",
      "ui-popover": "var(--ui-shadow-popover)",
      "ui-dialog": "var(--ui-shadow-dialog)",
    },
  },
  shortcuts: {
    // Text
    "ui-page-title": "m-0 text-lg font-semibold",
    "ui-section-title": "m-0 text-[13px] font-semibold text-ui-text-muted",
    "ui-section-header": "mb-2 flex min-h-8 items-center justify-between gap-3",
    "ui-badge": "rounded-md bg-ui-badge px-1.5 text-xs leading-5 text-ui-text-muted",

    // Controls
    "ui-button": `${button} border-ui-border-strong bg-ui-control text-ui-text enabled:hover:bg-ui-control-hover disabled:op-50`,
    "ui-button-primary": `${button} border-transparent bg-ui-action text-ui-action-text enabled:hover:bg-ui-action-hover disabled:bg-ui-action-disabled disabled:text-ui-text-faint`,
    "ui-button-danger": `${button} border-ui-danger/30 bg-ui-danger/8 text-ui-danger enabled:hover:bg-ui-danger/14 disabled:op-50`,
    "ui-text-button":
      "app-no-drag inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] text-ui-text-muted",
    "ui-input":
      "w-full min-w-0 rounded-lg border border-ui-border-strong bg-ui-control px-2.5 py-1.5 leading-5 text-ui-text select-text transition-colors hover:border-ui-text-faint focus-visible:border-ui-accent focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ui-accent/20 disabled:cursor-default disabled:op-50 disabled:hover:border-ui-border-strong",
    "ui-switch":
      "relative h-5 w-9 shrink-0 cursor-pointer rounded-full bg-ui-border-strong transition-colors [&[aria-checked=true]]:bg-ui-accent disabled:op-50",
    "ui-switch-thumb":
      "absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-ui-switch-thumb shadow-ui-card transition-transform",

    // Surfaces
    "ui-card": "overflow-hidden rounded-xl border border-ui-border bg-ui-surface",
    "ui-card-row": "flex min-h-11 items-center gap-3 px-4 py-2",
    "ui-option-card":
      "flex w-full cursor-pointer items-center gap-3 rounded-xl border border-ui-border bg-ui-surface px-4 py-3.5 text-left transition-colors enabled:hover:border-ui-border-strong enabled:hover:bg-ui-control-hover disabled:cursor-default",
    "ui-empty":
      "flex flex-col items-center gap-1 rounded-xl border border-dashed border-ui-border-strong px-6 py-10 text-center",
    "ui-dialog":
      "max-w-[calc(100vw-2rem)] rounded-2xl border border-ui-border bg-ui-surface p-6 text-ui-text shadow-ui-dialog",
    "ui-dialog-title": "m-0 text-base font-semibold",
    "ui-dialog-description": "m-0 mt-1.5 text-[13px] leading-relaxed text-ui-text-muted",
    "ui-dialog-actions": "mt-6 flex justify-end gap-2",
    "ui-menu": "rounded-xl border border-ui-border bg-ui-surface p-1 shadow-ui-popover",
    "ui-menu-item":
      "flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-ui-text hover:bg-ui-hover focus:bg-ui-hover disabled:cursor-default disabled:op-50",
    "ui-notice": "flex items-center gap-2 rounded-xl border px-3 py-2 text-[13px]",

    // Navigation
    "ui-nav-item": "flex h-8 items-center gap-2.5 rounded-lg text-ui-text transition-colors hover:bg-ui-hover",
    "ui-nav-active": "bg-ui-accent/12 text-ui-accent hover:bg-ui-accent/12",
    "ui-avatar": "inline-flex shrink-0 items-center justify-center bg-ui-avatar text-xs font-semibold text-ui-avatar-text",
  },
  rules: [
    // Frameless windows move by dragging these regions; controls inside opt out.
    ["app-drag", { "app-region": "drag", "-webkit-app-region": "drag" }],
    ["app-no-drag", { "app-region": "no-drag", "-webkit-app-region": "no-drag" }],
  ],
})
