import { constants } from "node:fs"
import { copyFile, link, lstat, mkdir, open, readdir, realpath, rm, rmdir, unlink } from "node:fs/promises"
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { ContentBlock } from "@agentclientprotocol/sdk/unstable"

const DRAFT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const STALE_DRAFT_MS = 24 * 60 * 60 * 1000
const DRAFT_SWEEP_INTERVAL_MS = 10 * 60 * 1000

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "image/bmp": ".bmp",
  "image/svg+xml": ".svg",
  "image/vnd.microsoft.icon": ".ico",
}

function safeFileName(raw: string, fallback: string): string {
  const cleaned = basename(raw.replaceAll("\\", "/")).replace(/[\0-\x1f<>:"/\\|?*]+/gu, "_").trim()
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback
  return cleaned.slice(0, 200)
}

function resourceFileName(uri: string): string {
  const pathPart = uri.split(/[?#]/u, 1)[0] ?? ""
  let decoded = pathPart
  try { decoded = decodeURIComponent(pathPart) } catch { /* keep raw */ }
  const candidate = safeFileName(decoded, "pasted-text.txt")
  return extname(candidate) ? candidate : `${candidate}.txt`
}

/** Daemon-managed Session attachment storage outside optional Git worktrees. */
export class SessionAttachments {
  readonly #directory: string
  readonly #draftsDirectory: string
  #lastSweepAt = 0

  constructor(directory: string) {
    this.#directory = resolve(directory, "session-attachments")
    this.#draftsDirectory = join(this.#directory, ".drafts")
  }

  #sessionPath(sessionId: string): string {
    if (!/^[1-9][0-9]*$/u.test(sessionId)) throw new Error("Invalid workspace session ID")
    return join(this.#directory, sessionId)
  }

  #draftPath(draftId: string): string {
    if (!DRAFT_ID.test(draftId)) throw new Error("Invalid draft attachment ID")
    return join(this.#draftsDirectory, draftId.toLowerCase())
  }

  async #sweepExpiredDrafts(): Promise<void> {
    const now = Date.now()
    if (now - this.#lastSweepAt < DRAFT_SWEEP_INTERVAL_MS) return
    this.#lastSweepAt = now
    const entries = await readdir(this.#draftsDirectory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory() || !DRAFT_ID.test(entry.name)) continue
      const candidate = join(this.#draftsDirectory, entry.name)
      const info = await lstat(candidate).catch(() => undefined)
      if (info && now - info.mtimeMs > STALE_DRAFT_MS) {
        await rm(candidate, { recursive: true, force: true }).catch(() => {})
      }
    }
  }

  async directory(sessionId: string): Promise<string> {
    const target = this.#sessionPath(sessionId)
    await mkdir(target, { recursive: true, mode: 0o700 })
    return realpath(target)
  }

  async draftDirectory(draftId: string): Promise<string> {
    await this.#sweepExpiredDrafts()
    const target = this.#draftPath(draftId)
    await mkdir(target, { recursive: true, mode: 0o700 })
    return realpath(target)
  }

  async #createUnique(sessionId: string, requestedName: string, writeAt: (destPath: string) => Promise<void>): Promise<{ path: string; uri: string; name: string }> {
    const dir = await this.directory(sessionId)
    const clean = safeFileName(requestedName, "attachment")
    const extension = extname(clean)
    const stem = extension ? clean.slice(0, -extension.length) : clean
    for (let index = 0; ; index++) {
      const name = index ? `${stem} (${index})${extension}` : clean
      const path = join(dir, name)
      try {
        await writeAt(path)
        return { path, uri: pathToFileURL(path).href, name }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue
        throw error
      }
    }
  }

  /** Move pre-uploaded draft files into the Session's attachment directory before recording input. */
  async adoptDrafts(sessionId: string, content: ContentBlock[]): Promise<ContentBlock[]> {
    const draftsRoot = await realpath(this.#draftsDirectory).catch(() => undefined)
    if (!draftsRoot) return content
    const adopted: ContentBlock[] = []
    for (const block of content) {
      if (block.type !== "resource_link" || !/^file:/iu.test(block.uri)) { adopted.push(block); continue }
      const rawPath = (() => { try { return fileURLToPath(block.uri, { windows: process.platform === "win32" }) } catch { return undefined } })()
      const canonical = rawPath ? await realpath(rawPath).catch(() => undefined) : undefined
      const rel = canonical ? relative(draftsRoot, canonical) : ""
      const parts = rel.split(sep)
      const info = canonical && rel && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel) && parts.length === 2 && DRAFT_ID.test(parts[0]!)
        ? await lstat(canonical).catch(() => undefined) : undefined
      if (!canonical || !info?.isFile()) { adopted.push(block); continue }
      const saved = await this.#createUnique(sessionId, block.name || parts[1]!, async destPath => {
        try { await link(canonical, destPath) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") throw error
          await copyFile(canonical, destPath, constants.COPYFILE_EXCL)
        }
        await unlink(canonical).catch(() => {})
        await rmdir(dirname(canonical)).catch(() => {})
      })
      adopted.push({ ...block, uri: saved.uri, name: saved.name, size: info.size })
    }
    return adopted
  }

  async write(sessionId: string, requestedName: string, data: Uint8Array): Promise<{ path: string; uri: string; name: string; size: number }> {
    const saved = await this.#createUnique(sessionId, requestedName, async path => {
      const handle = await open(path, "wx", 0o600)
      try {
        for (let offset = 0; offset < data.byteLength;) {
          const { bytesWritten } = await handle.write(data, offset, data.byteLength - offset, offset)
          if (!bytesWritten) throw new Error("Could not write attachment data")
          offset += bytesWritten
        }
      } finally {
        await handle.close()
      }
    })
    return { ...saved, size: data.byteLength }
  }

  /** Materialize unsupported inline blocks into `resource_link` files before provider delivery. */
  async preparePrompt(
    sessionId: string,
    content: ContentBlock[],
    capabilities?: { image?: boolean; embeddedContext?: boolean },
  ): Promise<ContentBlock[]> {
    const prepared: ContentBlock[] = []
    for (const block of content) {
      if (block.type === "image" && !capabilities?.image) {
        const extension = IMAGE_EXTENSIONS[block.mimeType.toLowerCase()] ?? ".bin"
        const saved = await this.write(sessionId, `image${extension}`, Buffer.from(block.data, "base64"))
        prepared.push({ type: "resource_link", uri: saved.uri, name: saved.name, mimeType: block.mimeType, size: saved.size })
        continue
      }
      if (block.type === "resource" && "text" in block.resource && !capabilities?.embeddedContext) {
        const saved = await this.write(sessionId, resourceFileName(block.resource.uri), Buffer.from(block.resource.text, "utf8"))
        prepared.push({
          type: "resource_link",
          uri: saved.uri,
          name: saved.name,
          mimeType: block.resource.mimeType ?? "text/plain",
          size: saved.size,
        })
        continue
      }
      prepared.push(block)
    }
    return prepared
  }

  async destroy(sessionId: string): Promise<void> {
    await rm(this.#sessionPath(sessionId), { recursive: true, force: true })
  }
}
