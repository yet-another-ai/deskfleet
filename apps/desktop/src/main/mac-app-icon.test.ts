import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import sharp from "sharp"
import { parse as parseYaml } from "yaml"
import { expect, test } from "vitest"
import {
  composeMacAppIcon,
  MACOS_APP_ICON_BODY,
  MACOS_APP_ICON_CANVAS,
} from "../../scripts/mac-app-icon.ts"

const root = resolve(import.meta.dirname, "../../../..")
const artwork = resolve(root, "packages/components/src/assets/deskfleet.svg")
const iconMac = resolve(root, "apps/desktop/build/icon-mac.png")
const iconFullBleed = resolve(root, "apps/desktop/build/icon.png")
const electronBuilder = resolve(root, "apps/desktop/electron-builder.yml")

async function opaqueBounds(png: Buffer): Promise<{ left: number, top: number, width: number, height: number }> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let minX = info.width
  let minY = info.height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (data[(y * info.width + x) * 4 + 3]! > 8) {
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
      }
    }
  }
  expect(maxX).toBeGreaterThanOrEqual(0)
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

async function midEdgeAlpha(png: Buffer): Promise<number[]> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const mid = Math.floor(info.width / 2)
  const last = info.width - 1
  const alpha = (x: number, y: number) => data[(y * info.width + x) * 4 + 3]!
  return [alpha(0, mid), alpha(last, mid), alpha(mid, 0), alpha(mid, last)]
}

test("macOS app icon composition follows Apple's 824-on-1024 optical grid", async () => {
  const composed = await composeMacAppIcon(artwork)
  const metadata = await sharp(composed).metadata()
  expect(metadata.width).toBe(MACOS_APP_ICON_CANVAS)
  expect(metadata.height).toBe(MACOS_APP_ICON_CANVAS)
  expect(await midEdgeAlpha(composed)).toEqual([0, 0, 0, 0])

  const bounds = await opaqueBounds(composed)
  const margin = (MACOS_APP_ICON_CANVAS - MACOS_APP_ICON_BODY) / 2
  expect(bounds.left).toBe(margin)
  expect(bounds.top).toBe(margin)
  expect(bounds.width).toBe(MACOS_APP_ICON_BODY)
  expect(bounds.height).toBe(MACOS_APP_ICON_BODY)
})

test("committed icon-mac.png matches the optical grid and stays distinct from the full-bleed master", async () => {
  const committed = readFileSync(iconMac)
  const regenerated = await composeMacAppIcon(artwork)
  expect(committed.equals(regenerated)).toBe(true)
  expect(await midEdgeAlpha(committed)).toEqual([0, 0, 0, 0])

  const fullBleed = readFileSync(iconFullBleed)
  expect(await midEdgeAlpha(fullBleed)).not.toEqual([0, 0, 0, 0])
  const fullBleedBounds = await opaqueBounds(fullBleed)
  expect(fullBleedBounds.left).toBe(0)
  expect(fullBleedBounds.top).toBe(0)
  expect(fullBleedBounds.width).toBe(MACOS_APP_ICON_CANVAS)
  expect(fullBleedBounds.height).toBe(MACOS_APP_ICON_CANVAS)
})

test("electron-builder pins full-bleed icons for Linux and Windows so they do not inherit mac.icon", () => {
  // LinuxTargetHelper resolves [linux.icon, mac.icon ?? config.icon]; without an
  // explicit linux.icon the optically inset mac asset would shrink AppImage icons.
  const config = parseYaml(readFileSync(electronBuilder, "utf8")) as {
    mac?: { icon?: string }
    win?: { icon?: string }
    linux?: { icon?: string }
  }
  expect(config.mac?.icon).toBe("build/icon-mac.png")
  expect(config.win?.icon).toBe("build/icon.png")
  expect(config.linux?.icon).toBe("build/icon.png")
})
