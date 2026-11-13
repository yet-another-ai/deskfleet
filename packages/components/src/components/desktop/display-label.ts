import type { DesktopDisplay } from "@deskfleet/client/desktop-media"

type Translate = (key: string, values: Record<string, string | number>) => string

/** Capture IDs are session handles; labels use the host's number or list order. */
export function displayLabel(display: DesktopDisplay, index: number, t: Translate): string {
  const number = t("desktop.displayName", { number: display.displayNumber ?? index + 1 })
  return display.name ? `${number} · ${display.name}` : number
}

export function displayOptionLabel(display: DesktopDisplay, index: number, t: Translate): string {
  return t("desktop.displayOption", {
    display: displayLabel(display, index, t), width: display.width, height: display.height,
  })
}
