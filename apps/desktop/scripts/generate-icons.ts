// Derives every product icon from the shared, unmodified brand artwork.
// Run with `mise exec -- pnpm --filter @deskfleet/desktop icons` and commit the output.
import { copyFile, mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import sharp from "sharp"

const root = resolve(import.meta.dirname, "../../..")
const artwork = resolve(root, "packages/components/src/assets/deskfleet.png")
const desktopBuild = resolve(root, "apps/desktop/build")
const publicDirectories = [
  resolve(root, "apps/web/public"),
  resolve(root, "apps/desktop/src/renderer/public"),
  resolve(root, "docs/content/public"),
]

async function resize(destination: string, size: number): Promise<void> {
  await sharp(artwork).resize(size, size).png().toFile(destination)
}

// ICO permits a PNG payload; only its directory entry needs wrapping here.
async function favicon(): Promise<Buffer> {
  const png = await sharp(artwork).resize(32, 32).ensureAlpha().png().toBuffer()
  const directory = Buffer.alloc(22)
  directory.writeUInt16LE(1, 2) // Icon resource type.
  directory.writeUInt16LE(1, 4) // One image.
  directory[6] = 32
  directory[7] = 32
  directory.writeUInt16LE(1, 10) // Color planes.
  directory.writeUInt16LE(32, 12) // Bits per pixel.
  directory.writeUInt32LE(png.length, 14)
  directory.writeUInt32LE(directory.length, 18)
  return Buffer.concat([directory, png])
}

// Electron recognizes the Template suffix and tints these alpha masks to match
// the macOS menu bar. Keep the artwork's silhouette while removing its dark
// background; a grayscale RGB image would otherwise become a solid square.
async function template(destination: string, size: number): Promise<void> {
  const alpha = await sharp(artwork)
    .resize(size, size)
    .greyscale()
    .linear(1.25, -40)
    .raw()
    .toBuffer()
  await sharp({ create: { width: size, height: size, channels: 3, background: "black" } })
    .joinChannel(alpha, { raw: { width: size, height: size, channels: 1 } })
    .png()
    .toFile(destination)
}

await Promise.all(publicDirectories.map(directory => mkdir(directory, { recursive: true })))

// electron-builder derives the macOS .icns and Windows .ico from this image.
await resize(resolve(desktopBuild, "icon.png"), 1024)
for (const [suffix, size] of [["", 16], ["@2x", 32]] as const) {
  await resize(resolve(desktopBuild, `tray${suffix}.png`), size)
  await template(resolve(desktopBuild, `trayTemplate${suffix}.png`), size)
}

const ico = await favicon()
for (const directory of publicDirectories) {
  await resize(resolve(directory, "favicon-32x32.png"), 32)
  await resize(resolve(directory, "apple-touch-icon.png"), 180)
  await writeFile(resolve(directory, "favicon.ico"), ico)
}

const websitePublic = publicDirectories[2]!
await resize(resolve(websitePublic, "logo.png"), 256)
await copyFile(artwork, resolve(websitePublic, "og.png"))
