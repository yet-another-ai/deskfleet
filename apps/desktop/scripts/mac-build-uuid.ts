import { createHash } from "node:crypto"
import { readFile, readdir, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"

interface MacBuildContext {
  electronPlatformName: string
  appOutDir: string
  packager: { appInfo: { id: string; productFilename: string } }
}

const MH_MAGIC_64 = 0xfeedfacf
const FAT_MAGIC = 0xcafebabe
const LC_UUID = 0x1b

/** Namespace Electron's build UUIDs without changing the Mach-O layout or code. */
export function rewriteMachOUuids(binary: Buffer, identity: string): Buffer {
  const result = Buffer.from(binary)
  const slices: { offset: number; size: number }[] = []
  if (binary.length >= 8 && binary.readUInt32BE(0) === FAT_MAGIC) {
    const count = binary.readUInt32BE(4)
    if (8 + count * 20 > binary.length) throw new Error("Invalid universal Mach-O header")
    for (let i = 0; i < count; i++) {
      const entry = 8 + i * 20
      slices.push({ offset: binary.readUInt32BE(entry + 8), size: binary.readUInt32BE(entry + 12) })
    }
  } else slices.push({ offset: 0, size: binary.length })

  for (const { offset, size } of slices) {
    if (size < 32 || offset + size > binary.length || binary.readUInt32LE(offset) !== MH_MAGIC_64) {
      throw new Error("Expected an Electron 64-bit Mach-O executable")
    }
    const commands = binary.readUInt32LE(offset + 16)
    const end = offset + 32 + binary.readUInt32LE(offset + 20)
    if (end > offset + size) throw new Error("Invalid Mach-O load command size")
    let cursor = offset + 32
    let uuidOffset: number | undefined
    for (let i = 0; i < commands; i++) {
      if (cursor + 8 > end) throw new Error("Truncated Mach-O load command")
      const command = binary.readUInt32LE(cursor)
      const commandSize = binary.readUInt32LE(cursor + 4)
      if (commandSize < 8 || cursor + commandSize > end) throw new Error("Invalid Mach-O load command")
      if (command === LC_UUID) {
        if (commandSize !== 24 || uuidOffset !== undefined) throw new Error("Invalid Mach-O build UUID")
        uuidOffset = cursor + 8
      }
      cursor += commandSize
    }
    if (uuidOffset === undefined) throw new Error("Mach-O executable has no build UUID")
    // The original UUID identifies the Electron build; CPU type/subtype distinguish slices.
    const uuid = createHash("sha256").update(identity).update("\0")
      .update(binary.subarray(offset + 4, offset + 12))
      .update(binary.subarray(uuidOffset, uuidOffset + 16)).digest().subarray(0, 16)
    uuid[6] = (uuid[6]! & 0x0f) | 0x80 // Application-defined UUID (version 8).
    uuid[8] = (uuid[8]! & 0x3f) | 0x80
    uuid.copy(result, uuidOffset)
  }
  return result
}

/** Run before signing: macOS Local Network privacy identifies apps by executable UUID. */
export default async function macBuildUuid(context: MacBuildContext): Promise<void> {
  if (context.electronPlatformName !== "darwin") return
  const { appInfo } = context.packager
  const app = join(context.appOutDir, `${appInfo.productFilename}.app`)
  const frameworks = join(app, "Contents", "Frameworks")
  const helpers = (await readdir(frameworks, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name.endsWith(".app"))
    .map(entry => join(frameworks, entry.name))
  // Shared frameworks keep upstream UUIDs so their debug symbols still match.
  for (const bundle of [app, ...helpers]) {
    const executables = join(bundle, "Contents", "MacOS")
    for (const entry of await readdir(executables, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const path = join(executables, entry.name)
      const identity = `${appInfo.id}\0${relative(app, path).split("\\").join("/")}`
      await writeFile(path, rewriteMachOUuids(await readFile(path), identity))
    }
  }
}
