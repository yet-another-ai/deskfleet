// macOS Dock and Finder icons follow Apple's 1024 canvas grid: an 824 px body
// centered with a 100 px transparent margin. Full-bleed artwork looks oversized
// next to system icons after electron-builder derives the .icns. See issue #652.
import sharp from "sharp"

/** Canvas edge length for the macOS app icon PNG that becomes the .icns. */
export const MACOS_APP_ICON_CANVAS = 1024

/** Opaque body edge length on Apple's macOS icon grid (100 px margin each side). */
export const MACOS_APP_ICON_BODY = 824

/**
 * Scale brand artwork to the Apple body size and center it on a transparent
 * canvas so Dock and Finder optical size matches neighboring system icons.
 */
export async function composeMacAppIcon(artwork: string | Buffer): Promise<Buffer> {
  const body = await sharp(artwork)
    .resize(MACOS_APP_ICON_BODY, MACOS_APP_ICON_BODY)
    .ensureAlpha()
    .png()
    .toBuffer()
  return sharp({
    create: {
      width: MACOS_APP_ICON_CANVAS,
      height: MACOS_APP_ICON_CANVAS,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: body, gravity: "centre" }])
    .png()
    .toBuffer()
}
