import { createHash, timingSafeEqual } from "node:crypto"
import { constants } from "node:fs"
import { access, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { basename, extname, isAbsolute, join, relative, sep } from "node:path"
import { pipeline } from "node:stream/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import { openWorkspaceFile } from "./evidence.ts"
import { isGithubItemUri, type ComposerFileReference } from "@deskfleet/protocol/composer-reference"
import { messageContent } from "../agent/params.ts"
import { AGENT_MESSAGE_BYTES, type AgentInput } from "@deskfleet/protocol/agent"
import { FILE_PREVIEW_BYTES } from "@deskfleet/protocol/files"
import type { SuperAttachmentInfo, SuperAttachmentPreview } from "@deskfleet/protocol/super-agent"

type Block = AgentInput["content"][number]
export type SuperAttachment = Extract<Block, { type: "resource" | "resource_link" | "image" }>
type Attachment = SuperAttachment
export type SuperImage = Extract<Block, { type: "image" }>
type AttachmentPreview = SuperAttachmentInfo & { excerpt?: string; truncated?: boolean; image?: number; unavailable?: boolean }
export type SuperAttachmentContext = { previews: AttachmentPreview[]; images: SuperImage[] }
const digest = (value: string) => createHash("sha256").update(value).digest("hex")
const acceptedVision = new Map([[".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".gif", "image/gif"], [".webp", "image/webp"]])

export function superAttachments(value: unknown): Attachment[] {
  if (value === undefined || Array.isArray(value) && !value.length) return []
  if (!Array.isArray(value) || value.length > 99) throw new Error("Invalid workspace message attachments")
  // Use the same wire validation as ordinary input; the host appends the Worker instruction at dispatch.
  const blocks = messageContent([...value, { type: "text", text: "attachment validation" }]).slice(0, -1)
  const result: Attachment[] = blocks.map(block => {
    if (block.type === "image") return { type: "image", data: block.data, mimeType: block.mimeType }
    if (block.type === "resource_link") {
      fileURLToPath(block.uri)
      const grant = block._meta?.["deskfleet/attachmentGrant"]
      if (grant !== undefined && (typeof grant !== "string" || !/^[a-f0-9]{64}$/u.test(grant))) throw new Error("Invalid attachment grant")
      return { type: "resource_link", name: block.name, uri: block.uri, mimeType: block.mimeType, size: block.size,
        ...(grant ? { _meta: { "deskfleet/attachmentGrant": grant } } : {}) }
    }
    if (block.type === "resource" && "text" in block.resource) {
      const { uri, mimeType, text } = block.resource
      return { type: "resource", resource: { uri, mimeType, text } }
    }
    throw new Error("Unsupported workspace attachment")
  })
  if (Buffer.byteLength(JSON.stringify(result)) > AGENT_MESSAGE_BYTES) throw new Error("Workspace message attachments exceed the machine channel limit")
  return result
}

export function assertAttachmentBudget(blocks: readonly Attachment[]): void {
  if (blocks.length > 99) throw new Error("Invalid workspace message attachments")
  if (Buffer.byteLength(JSON.stringify(blocks.map(({ _meta, ...block }) => block))) > AGENT_MESSAGE_BYTES) {
    throw new Error("Workspace message attachments exceed the machine channel limit")
  }
}

export function attachmentInfo(block: Attachment): SuperAttachmentInfo {
  if (block.type === "resource_link") return { type: block.type, name: block.name }
  if (block.type === "image") return { type: block.type, name: block.mimeType }
  if ("text" in block.resource && isGithubItemUri(block.resource.uri)) {
    return { type: block.type, name: block.resource.text.slice(0, 256).split(/\r?\n/u, 1)[0] || block.resource.uri }
  }
  return { type: block.type, name: block.resource.uri.startsWith("deskfleet://pasted-text/") ? "text/plain" : block.resource.uri.split("/").pop() || "text/plain" }
}

/** Keep the ledger small. Groups are immutable, registration-local and private to the sender. */
export class SuperAttachmentStore {
  readonly root: string
  readonly fileGrant: (uid: string, canonicalPath: string) => string
  constructor(directory: string, fileGrant: (uid: string, canonicalPath: string) => string) {
    this.root = join(directory, "super-agent-attachments")
    this.fileGrant = fileGrant
  }
  key(messageId: string, blocks: Attachment[]): string {
    return digest(JSON.stringify([messageId, blocks.map(({ _meta, ...block }) => block)]))
  }
  async save(uid: string, key: string, blocks: Attachment[], roots: string[], trustedPaths?: ReadonlySet<string>): Promise<void> {
    const owner = join(this.root, digest(uid))
    const destination = join(owner, key)
    if (await access(join(destination, "content.json")).then(() => true, () => false)) return
    const allowed = await Promise.all(roots.map(root => realpath(root).catch(() => undefined)))
    await mkdir(owner, { recursive: true, mode: 0o700 })
    const staging = await mkdtemp(join(owner, ".pending-"))
    try {
      const saved: Attachment[] = []
      for (const [i, block] of blocks.entries()) {
        if (block.type !== "resource_link") { saved.push(block); continue }
        const path = await realpath(fileURLToPath(block.uri))
        const grant = block._meta?.["deskfleet/attachmentGrant"]
        const hasGrant = typeof grant === "string" && grant.length === 64 &&
          timingSafeEqual(Buffer.from(grant), Buffer.from(this.fileGrant(uid, path)))
        const trusted = trustedPaths?.has(path) === true
        if (!hasGrant && !trusted && !allowed.some(root => {
          if (!root) return false
          const rel = relative(root, path)
          return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
        })) throw new Error("Select the file again on this machine to authorize this attachment.")
        const known = await stat(path)
        if (!known.isFile()) throw new Error("Only regular files can be attached")
        const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
        try {
          const info = await handle.stat()
          if (info.ino !== known.ino || info.dev !== known.dev || !info.isFile() || await realpath(path) !== path) throw new Error("The attachment changed before it was opened")
          const folder = String(i), name = basename(path)
          await mkdir(join(staging, folder), { mode: 0o700 })
          const file = await open(join(staging, folder, name), "wx", 0o600)
          try {
            await pipeline(handle.createReadStream({ autoClose: false }), file.createWriteStream())
          } finally { await file.close() }
          const after = await handle.stat()
          if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error("The attachment changed while being copied")
          // Snapshot once: pre-uploads expire and a file chosen on a machine may change before another ticket uses it.
          const { _meta, ...withoutGrant } = block
          saved.push({ ...withoutGrant, uri: pathToFileURL(join(destination, folder, name)).href, size: info.size })
        } finally { await handle.close() }
      }
      await writeFile(join(staging, "content.json"), JSON.stringify(saved), { mode: 0o600 })
      try { await rename(staging, destination) }
      catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error
        await access(join(destination, "content.json"))
      }
    } finally { await rm(staging, { recursive: true, force: true }) }
  }
  async load(uid: string, keys: readonly string[]): Promise<Attachment[]> {
    const blocks: Attachment[] = []
    for (const key of new Set(keys)) {
      if (!/^[0-9a-f]{64}$/u.test(key)) throw new Error("Invalid stored attachment reference")
      blocks.push(...JSON.parse(await readFile(join(this.root, digest(uid), key, "content.json"), "utf8")) as Attachment[])
    }
    return blocks
  }
  /** Resolve one immutable attachment from an earlier user message owned by `uid` for safe reuse on re-edit. */
  async resolveReused(uid: string, keys: readonly string[], index: number): Promise<{ block: Attachment; trustedPath?: string }> {
    const block = (await this.load(uid, keys))[index]
    if (!block) throw new Error("Attachment unavailable in this conversation")
    if (block.type !== "resource_link") return { block }
    const owner = await realpath(join(this.root, digest(uid)))
    const path = await realpath(fileURLToPath(block.uri))
    const parts = relative(owner, path).split(sep)
    if (parts.length !== 3 || !keys.includes(parts[0]!) || !/^\d+$/u.test(parts[1]!)) {
      throw new Error("Attachment unavailable in this conversation")
    }
    return { block, trustedPath: path }
  }
  /** Only callers that resolved the message in the owner's room can supply these ledger keys. */
  async preview(uid: string, keys: readonly string[], index: number): Promise<SuperAttachmentPreview> {
    try {
      const block = (await this.load(uid, keys))[index]
      if (block?.type === "image") {
        if (Buffer.byteLength(block.data, "base64") > FILE_PREVIEW_BYTES) return { type: "tooLarge" }
        return { type: "image", mimeType: block.mimeType, data: block.data }
      }
      if (block?.type === "resource" && "text" in block.resource) {
        const { text, uri, mimeType } = block.resource
        if (Buffer.byteLength(JSON.stringify(text)) > FILE_PREVIEW_BYTES) return { type: "tooLarge" }
        return { type: "resource", text, ...(isGithubItemUri(uri) && { uri, mimeType }) }
      }
      if (block?.type === "resource_link") {
        // Only read the immutable, server-created copy; never resolve a path supplied by the client.
        const path = fileURLToPath(block.uri)
        const owner = await realpath(join(this.root, digest(uid)))
        const parts = relative(owner, await realpath(path)).split(sep)
        if (parts.length !== 3 || !keys.includes(parts[0]!) || !/^\d+$/u.test(parts[1]!)) return { type: "unavailable" }
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        try {
          const info = await file.stat()
          if (!info.isFile()) return { type: "unavailable" }
          if (info.size > FILE_PREVIEW_BYTES) return { type: "tooLarge" }
          const bytes = Buffer.alloc(info.size)
          for (let offset = 0; offset < info.size;) {
            const { bytesRead } = await file.read(bytes, offset, info.size - offset, offset)
            if (!bytesRead) return { type: "unavailable" }
            offset += bytesRead
          }
          return { type: "resource_link", data: bytes.toString("base64"), mimeType: block.mimeType ?? "application/octet-stream" }
        } finally { await file.close() }
      }
    } catch {
      // Filesystem errors include private registration paths. Never send them to a renderer.
    }
    return { type: "unavailable" }
  }
}

/** The coordinator can inspect only explicit material from this message or its quote. Workers receive the original blocks. */
export async function previewSuperAttachments(blocks: Attachment[], references?: ReadonlyMap<Extract<Block, { type: "resource_link" }>, ComposerFileReference>): Promise<SuperAttachmentContext> {
  const previews: AttachmentPreview[] = [], images: SuperImage[] = []
  let chars = 40_000, imageBytes = 16 * 1024 * 1024
  const image = (block: SuperImage, preview: AttachmentPreview) => {
    const bytes = Buffer.byteLength(block.data, "base64")
    if (bytes <= imageBytes && ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(block.mimeType)) {
      imageBytes -= bytes
      preview.image = images.length + 1
      images.push(block)
    } else preview.unavailable = true
  }
  for (const block of blocks) {
    const preview: AttachmentPreview = attachmentInfo(block)
    previews.push(preview)
    if (block.type === "image") { image(block, preview); continue }
    const limit = Math.min(12_000, chars)
    if (block.type === "resource" && "text" in block.resource) {
      preview.excerpt = block.resource.text.slice(0, limit)
      preview.truncated = preview.excerpt.length < block.resource.text.length
    } else if (block.type === "resource_link") {
      const path = fileURLToPath(block.uri)
      const selected = references?.get(block)
      const handle = await (selected
        ? realpath(selected.sourceDirectory).then(root => openWorkspaceFile(root, selected.relativePath)).then(opened => opened.file)
        : open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)).catch(() => undefined)
      if (!handle) { preview.unavailable = true; continue }
      try {
        const info = await handle.stat()
        if (!info.isFile()) { preview.unavailable = true; continue }
        const mimeType = block.mimeType || acceptedVision.get(extname(path).toLowerCase())
        if (mimeType?.startsWith("image/")) {
          if (info.size > Math.min(8 * 1024 * 1024, imageBytes)) { preview.unavailable = true; continue }
          const bytes = Buffer.alloc(info.size)
          const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
          image({ type: "image", mimeType, data: bytes.subarray(0, bytesRead).toString("base64") }, preview)
        } else {
          const buffer = Buffer.alloc(Math.min(info.size, limit))
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
          const bytes = buffer.subarray(0, bytesRead)
          if (bytes.includes(0)) { preview.unavailable = true; continue }
          preview.truncated = bytesRead < info.size
          preview.excerpt = new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: preview.truncated })
        }
      } catch { preview.unavailable = true }
      finally { await handle.close() }
    }
    chars -= preview.excerpt?.length ?? 0
  }
  return { previews, images }
}
