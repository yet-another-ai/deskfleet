import type { AgentEvent, AgentInput, AgentSnapshot } from "../../../../apps/daemon/src/agent-protocol.ts"
import { projectConversation } from "./agent-conversation.ts"
import type { AgentSessionSummary } from "../stores/fleet-types.ts"

export interface SessionMessagePreview {
  userMessage?: string
  assistantReply?: string
}

const textOf = (content: AgentInput["content"]) => content
  .map(block => block.type === "text" ? block.text : block.type === "resource" && "text" in block.resource ? block.resource.text : "")
  .join(" ")
  .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
  .replace(/[`*_~]+/gu, "")
  .replace(/^\s{0,3}(?:#+|>|[-*+])\s+/gmu, "")
  .replace(/\s+/gu, " ")
  .trim()

const truncate = (text: string, limit = 20) => {
  const chars = [...text]
  return chars.length > limit ? `${chars.slice(0, limit).join("")}…` : chars.length ? text : undefined
}

export const latestSessionInput = (inputs: readonly AgentInput[]) =>
  inputs.findLast(input => input.state !== "withdrawn") ?? inputs.at(-1)

export function extractSessionPreview(snapshot: AgentSnapshot, events: readonly AgentEvent[]): SessionMessagePreview {
  const input = latestSessionInput(snapshot.inputs)
  if (!input) return {}
  const after = BigInt(input.acceptedSeq)
  const reply = projectConversation(events.filter(event => BigInt(event.seq) > after), snapshot)
    .findLast(entry => entry.kind === "message" && entry.role === "assistant" && textOf(entry.content).length > 0)
  return {
    userMessage: truncate(textOf(input.content)),
    assistantReply: reply?.kind === "message" ? truncate(textOf(reply.content)) : undefined,
  }
}

export function snapshotLastMessageAt(snapshot: Pick<AgentSnapshot, "session" | "inputs" | "turns">): string | undefined {
  return [snapshot.session.lastMessageAt, latestSessionInput(snapshot.inputs)?.createdAt, ...snapshot.turns.map(t => t.endedAt)]
    .reduce<string | undefined>((latest, at) => at && (!latest || at > latest) ? at : latest, undefined)
}

export function compareSessionsByRecency(
  left: Pick<AgentSessionSummary, "lastMessageAt" | "createdAt">,
  right: Pick<AgentSessionSummary, "lastMessageAt" | "createdAt">,
): number {
  const a = left.lastMessageAt ?? left.createdAt
  const b = right.lastMessageAt ?? right.createdAt
  return !a && !b ? 0 : !a ? 1 : !b ? -1 : b.localeCompare(a)
}
