import earth from "./relay-earth.svg?raw"

export function relayPalette(host: HTMLElement) {
  const probe = document.createElement("span")
  probe.style.position = "absolute"
  probe.style.visibility = "hidden"
  host.append(probe)
  const color = (token: string) => {
    // Resolve CSS color tokens before passing colors to WebGL.
    probe.style.color = `var(--ui-color-${token})`
    return getComputedStyle(probe).color
  }
  const palette = {
    ocean: color("canvas"), land: color("border"), coast: color("border-strong"),
    accent: color("accent"), muted: color("text-muted"), text: color("text"), surface: color("surface"),
  }
  probe.remove()
  return palette
}

export function relayTexture(palette: ReturnType<typeof relayPalette>) {
  const svg = earth
    .replaceAll("var(--relay-ocean)", palette.ocean)
    .replaceAll("var(--relay-land)", palette.land)
    .replaceAll("var(--relay-coast)", palette.coast)
    .replaceAll("var(--relay-grid)", palette.muted)
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}
