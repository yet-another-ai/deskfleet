import { defineConfig, presetWind4 } from "unocss"

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
  "scrim",
  "success",
  "warning",
  "danger",
  "switch-thumb",
  "terminal",
  "desktop",
] as const

// Buttons share a shape; each variant sets its colors. Utilities on the element still override the shortcut.
// Pressing a button settles it slightly; inert buttons stay still.
const button =
  "app-no-drag inline-flex items-center justify-center gap-1.5 whitespace-nowrap squircle-lg border px-3 py-1.5 text-[13px] font-medium leading-5 cursor-pointer ui-motion enabled:active:scale-[0.97] [&[aria-disabled=true]]:active:scale-100 disabled:cursor-default [&[aria-disabled=true]]:cursor-default"

export default defineConfig({
  presets: [presetWind4()],
  content: {
    pipeline: {
      include: [/\.(vue|[jt]sx|mdx?|html)($|\?)/, /\.stories\.ts($|\?)/],
    },
  },
  theme: {
    font: { mono: "var(--ui-font-mono)" },
    colors: Object.fromEntries(colorNames.map((name) => [`ui-${name}`, `var(--ui-color-${name})`])),
    shadow: {
      "ui-card": "var(--ui-shadow-card)",
      "ui-raised": "var(--ui-shadow-raised)",
      "ui-glow": "var(--ui-shadow-glow)",
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
    "ui-button": `${button} border-ui-border-strong bg-ui-control text-ui-text enabled:hover:bg-ui-control-hover enabled:active:bg-ui-active disabled:op-50`,
    "ui-button-primary": `${button} border-transparent bg-ui-action text-ui-action-text enabled:hover:bg-ui-action-hover disabled:bg-ui-action-disabled disabled:text-ui-text-faint`,
    "ui-button-danger": `${button} border-ui-danger/30 bg-ui-danger/8 text-ui-danger enabled:hover:border-ui-danger/45 enabled:hover:bg-ui-danger/14 enabled:active:bg-ui-danger/20 disabled:op-50`,
    "ui-button-ghost": `${button} border-transparent bg-transparent text-ui-text-muted enabled:hover:bg-ui-hover enabled:hover:text-ui-text enabled:active:bg-ui-active disabled:op-40`,
    "ui-text-button":
      `${button} h-7 border-transparent bg-transparent px-2 text-ui-text-muted enabled:hover:bg-ui-hover enabled:hover:text-ui-text disabled:op-40`,
    "ui-input":
      "w-full min-w-0 rounded-lg border border-ui-border-strong bg-ui-control px-2.5 py-1.5 leading-5 text-ui-text select-text ui-motion hover:border-ui-text-faint focus-visible:border-ui-accent focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ui-accent/20 disabled:cursor-default disabled:op-50 disabled:hover:border-ui-border-strong",
    "ui-switch":
      "relative h-5 w-9 shrink-0 cursor-pointer rounded-full bg-ui-border-strong ui-motion [&[aria-checked=true]]:bg-ui-accent disabled:op-50",
    "ui-switch-thumb":
      "absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-ui-switch-thumb shadow-ui-card",
    // A radio's ring; the checked item's ring tints, and its `ui-radio-dot` indicator springs in.
    "ui-radio":
      "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-ui-border-strong bg-ui-control ui-motion",
    "ui-radio-dot": "h-2 w-2 rounded-full bg-ui-accent",

    // Surfaces
    "ui-card": "overflow-hidden squircle-xl border border-ui-border-strong bg-ui-surface",
    "ui-card-row": "flex min-h-11 items-center gap-3 px-4 py-2",
    "ui-option-card":
      "flex w-full cursor-pointer items-center gap-3 squircle-xl border border-ui-border-strong bg-ui-surface px-4 py-3.5 text-left ui-motion duration-[var(--ui-duration-base)] enabled:hover:-translate-y-px enabled:hover:border-ui-border-strong enabled:hover:bg-ui-control-hover enabled:hover:shadow-ui-raised enabled:active:translate-y-0 enabled:active:scale-[0.99] disabled:cursor-default",
    "ui-empty":
      "flex flex-col items-center gap-1 rounded-xl border border-dashed border-ui-border-strong bg-ui-surface/40 px-6 py-10 text-center",
    "ui-dialog":
      "max-w-[calc(100vw-2rem)] rounded-2xl border border-ui-border bg-ui-surface p-6 text-ui-text shadow-ui-dialog",
    "ui-dialog-title": "m-0 text-base font-semibold",
    "ui-dialog-description": "m-0 mt-1.5 text-[13px] leading-relaxed text-ui-text-muted",
    "ui-dialog-actions": "mt-6 flex justify-end gap-2",
    "ui-menu": "rounded-xl border border-ui-border bg-ui-surface p-1 shadow-ui-popover",
    "ui-menu-item":
      "flex min-h-8 w-full cursor-pointer select-none items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-ui-text outline-none hover:bg-ui-hover focus:bg-ui-hover data-[highlighted]:bg-ui-hover disabled:cursor-default disabled:op-50 data-[disabled]:pointer-events-none data-[disabled]:cursor-default data-[disabled]:op-50",
    "ui-notice": "flex items-center gap-2 rounded-xl border px-3 py-2 text-[13px]",
    // A segmented control: the active segment is a raised pill that settles in (styles.css).
    "ui-segmented": "flex rounded-lg border border-ui-border bg-ui-hover p-1",
    "ui-segment":
      "cursor-pointer whitespace-nowrap rounded-md px-3 py-1.5 text-xs text-ui-text-muted ui-motion hover:text-ui-text enabled:active:scale-[0.97] focus-visible:outline-2 focus-visible:outline-ui-accent",
    "ui-segment-active": "bg-ui-surface text-ui-text shadow-ui-card",

    // Status and progress. A status dot takes its color from `text-*`; add `ui-status-live` for running states.
    "ui-status-dot": "relative inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-current",
    "ui-meter": "h-1.5 overflow-hidden rounded-full bg-ui-hover",
    "ui-meter-fill": "h-full rounded-full",

    // Navigation
    "ui-nav-item": "flex h-8 items-center gap-2.5 rounded-lg [&:not(.ui-nav-active)]:text-ui-text ui-motion active:scale-[0.985] [&:not(.ui-nav-active):hover]:bg-ui-hover",
    "ui-nav-active": "bg-ui-accent/12 text-ui-accent hover:bg-ui-accent/20",
    // Underlined tabs; styles.css draws the underline, which grows in under `ui-tab-active`.
    "ui-tab": "relative flex shrink-0 cursor-pointer items-center whitespace-nowrap text-ui-text-muted ui-motion hover:text-ui-text",
    "ui-tab-active": "text-ui-accent hover:text-ui-accent",
    "ui-avatar": "inline-flex shrink-0 items-center justify-center bg-ui-avatar text-xs font-semibold text-ui-avatar-text",

    // Scrollbars: floating pill tracks shared by `UiScrollArea`.
    "ui-scrollbar":
      "group z-20 flex touch-none select-none p-0.5 data-[orientation=vertical]:w-2.5 data-[orientation=horizontal]:h-2.5 data-[orientation=horizontal]:flex-col",
    "ui-scrollbar-thumb":
      "relative flex-1 rounded-full bg-ui-text-faint/50 ui-motion group-hover:bg-ui-text-faint/70",
  },
  rules: [
    // Continuous-curvature corners: falls back to `border-radius` and scales up 1.25x when `corner-shape: superellipse(1.4)` is supported.
    [/^squircle(?:-(.+))?$/, function* ([, size = "DEFAULT"], { theme, symbols }) {
      const radius = theme.radius?.[size] ?? (size.startsWith("[") && size.endsWith("]") ? size.slice(1, -1) : undefined)
      if (!radius) return
      yield { "border-radius": radius }
      yield {
        [symbols.parent]: "@supports (corner-shape: superellipse(1.4))",
        "border-radius": `calc(${radius} * 1.25)`,
        "corner-shape": "superellipse(1.4)",
      }
    }],
    // The shared interaction transition: state colors, elevation, and press scale.
    // `duration-*` and `ease-*` utilities set these variables, so they adjust it regardless of CSS order.
    ["ui-motion", {
      "transition-property": "color, background-color, border-color, outline-color, box-shadow, opacity, transform, translate, scale, rotate",
      "transition-duration": "var(--un-duration, var(--ui-duration-fast))",
      "transition-timing-function": "var(--un-ease, var(--ui-ease-out))",
    }],
    // Frameless windows move by dragging these regions; controls inside opt out.
    ["app-drag", { "app-region": "drag", "-webkit-app-region": "drag" }],
    ["app-no-drag", { "app-region": "no-drag", "-webkit-app-region": "no-drag" }],
  ],
})
