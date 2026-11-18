import type { GithubRepositoryItem } from "@deskfleet/client/central"
import type { ComposerAttachment } from "./composer-attachments.ts"

export interface GithubReferenceScope {
  teamId: string
  machineId: string
  workspaceId: string
}

export const githubItemDragType = "application/x-deskfleet-github-item"

export function writeGithubItemDrag(transfer: DataTransfer, scope: GithubReferenceScope, item: GithubRepositoryItem): void {
  transfer.effectAllowed = "copy"
  transfer.setData(githubItemDragType, JSON.stringify({ scope, item }))
}

export function readGithubItemDrag(transfer: DataTransfer, target: GithubReferenceScope): GithubRepositoryItem | undefined {
  try {
    const { scope, item } = JSON.parse(transfer.getData(githubItemDragType))
    if (scope?.teamId !== target.teamId || scope.machineId !== target.machineId || scope.workspaceId !== target.workspaceId) return
    if (!item || (item.kind !== "issue" && item.kind !== "pullRequest") || typeof item.title !== "string" || typeof item.body !== "string"
      || !Number.isSafeInteger(item.number) || item.number < 1 || typeof item.repository !== "string"
      || !/^[\w.-]+\/[\w.-]+$/u.test(item.repository) || typeof item.url !== "string") return
    const url = `https://github.com/${item.repository}/${item.kind === "issue" ? "issues" : "pull"}/${item.number}`
    if (item.url.toLowerCase() === url.toLowerCase()) return item
  } catch {
    // A native drop may carry an empty or foreign payload.
  }
}

export function withGithubReference(attachments: ComposerAttachment[], item: GithubRepositoryItem): ComposerAttachment[] {
  if (attachments.some(attachment => attachment.kind === "github" && attachment.item.url.toLowerCase() === item.url.toLowerCase())) return attachments
  return [...attachments, { id: crypto.randomUUID(), kind: "github", item }]
}

export function githubReferenceLabel(item: GithubRepositoryItem): string {
  return `${item.repository}#${item.number} · ${item.title}`
}
