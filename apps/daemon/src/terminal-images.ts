import { createReadStream } from "node:fs"
import { basename } from "node:path"
import type { Readable, Writable } from "node:stream"

export const ICAT_ARGUMENT = "--deskfleet-icat"
// Keep these aligned with TerminalSurface's image addon limits.
export const ICAT_FILE_BYTES = 20_000_000
export const ICAT_IMAGE_PIXELS = 16_777_216

const help = `Usage: icat [--] [FILE|-]
Display a PNG, JPEG, or GIF in a DeskFleet terminal. GIFs show their first frame.
Read from standard input when FILE is omitted or is -.
Images must be at most 20,000,000 bytes and smaller than 16,777,216 pixels.
This command supports --help; it does not implement kitten icat options.
`

function dimensions(data: Buffer): [number, number] {
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && data.toString("ascii", 12, 16) === "IHDR") {
    return [data.readUInt32BE(16), data.readUInt32BE(20)]
  }
  if (data.length >= 10 && ["GIF87a", "GIF89a"].includes(data.toString("ascii", 0, 6))) {
    return [data.readUInt16LE(6), data.readUInt16LE(8)]
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    for (let offset = 2; offset + 1 < data.length;) {
      if (data[offset++] !== 0xff) break
      while (data[offset] === 0xff) offset++
      const marker = data[offset++]
      if (marker === undefined || marker === 0xda || marker === 0xd9) break
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
      if (offset + 2 > data.length) break
      const length = data.readUInt16BE(offset)
      if (length < 2 || offset + length > data.length) break
      if (length >= 8 && marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return [data.readUInt16BE(offset + 5), data.readUInt16BE(offset + 3)]
      }
      offset += length
    }
  }
  throw new Error("Expected a PNG, JPEG, or GIF image with a readable image header")
}

/** The bytes travel inside the terminal transcript, so replay retains the same image. */
export function terminalImageSequence(data: Buffer, name: string): string {
  if (data.length > ICAT_FILE_BYTES) throw new Error("Image exceeds the 20,000,000-byte terminal image limit")
  const [width, height] = dimensions(data)
  if (width === 0 || height === 0) throw new Error("Image dimensions must be positive")
  if (width * height >= ICAT_IMAGE_PIXELS) throw new Error("Image must be smaller than 16,777,216 pixels; resize it before using icat")
  const encodedName = Buffer.from(name).toString("base64")
  // xterm's image addon supports the original iTerm File command, not MultipartFile.
  return `\x1b]1337;File=name=${encodedName};size=${data.length};inline=1;preserveAspectRatio=1:${data.toString("base64")}\x07\n`
}

async function readImage(source: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of source) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += data.length
    if (size > ICAT_FILE_BYTES) throw new Error("Image exceeds the 20,000,000-byte terminal image limit")
    chunks.push(data)
  }
  return Buffer.concat(chunks, size)
}

interface IcatStreams {
  input: Readable & { isTTY?: boolean }
  output: Writable
  error: Writable
}

function write(stream: Writable, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(value, error => { if (error) reject(error); else resolve() })
  })
}

/** Run before daemon/Electron startup so the bundled runtime needs no separate Node install. */
export async function runIcat(args: readonly string[], streams: IcatStreams = {
  input: process.stdin, output: process.stdout, error: process.stderr,
}): Promise<number> {
  try {
    if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
      await write(streams.output, help)
      return 0
    }
    const positional = args[0] === "--" ? args.slice(1) : args
    if (positional.length > 1 || (args[0] !== "--" && positional[0]?.startsWith("-") && positional[0] !== "-")) {
      throw new Error("Usage: icat [--] [FILE|-]. Use --help for details")
    }
    const path = positional[0]
    const fromStdin = path === undefined || path === "-"
    if (fromStdin && streams.input.isTTY) throw new Error("Provide an image path or pipe image bytes into icat")
    const data = await readImage(fromStdin ? streams.input : createReadStream(path))
    await write(streams.output, terminalImageSequence(data, fromStdin ? "stdin" : basename(path)))
    return 0
  } catch (error) {
    await write(streams.error, `icat: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
