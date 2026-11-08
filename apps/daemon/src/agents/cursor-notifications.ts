import { basename, isAbsolute, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type * as acp from "@agentclientprotocol/sdk/unstable"

export const CURSOR_NOTIFICATION_METHODS = ["cursor/update_todos", "cursor/task", "cursor/generate_image"] as const
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0
const statuses = new Set(["pending", "in_progress", "completed", "cancelled"])
interface Todo { id: string; content: string; status: "pending" | "in_progress" | "completed" | "cancelled" }

/** Cursor's notifications have no session ID; their connection owns the current session. */
export class CursorNotifications {
  #todos = new Map<string, Map<string, Todo>>()

  update(method: string, params: unknown, sessionId: string, cwd?: string): acp.SessionNotification | undefined {
    if (!record(params) || !text(params.toolCallId)) return undefined
    const meta = { cursor: { method, ...params } }
    if (method === "cursor/update_todos") {
      if (typeof params.merge !== "boolean" || !Array.isArray(params.todos)) return undefined
      const incoming: Todo[] = []
      for (const todo of params.todos) {
        if (!record(todo) || !text(todo.id) || !text(todo.content) || !text(todo.status) || !statuses.has(todo.status)) return undefined
        incoming.push({ id: todo.id, content: todo.content, status: todo.status as Todo["status"] })
      }
      const todos = params.merge ? this.#todos.get(sessionId) ?? new Map<string, Todo>() : new Map<string, Todo>()
      for (const todo of incoming) todos.set(todo.id, todo)
      this.#todos.set(sessionId, todos)
      return { sessionId, update: { sessionUpdate: "plan_update", _meta: meta, plan: {
        type: "items", planId: "cursor-todos", entries: [...todos.values()].map(todo => ({
          content: todo.content, priority: "medium", status: todo.status === "cancelled" ? "completed" : todo.status,
          _meta: { cursor: { id: todo.id, status: todo.status } },
        })),
      } } }
    }
    if (!text(params.description)) return undefined
    const content: acp.ToolCallContent[] = []
    if (method === "cursor/task") {
      if (!text(params.prompt)) return undefined
      content.push({ type: "content", content: { type: "text", text: params.prompt } })
    } else if (method === "cursor/generate_image") {
      if (text(params.filePath)) {
        const path = isAbsolute(params.filePath) ? params.filePath : cwd ? resolve(cwd, params.filePath) : undefined
        if (path) content.push({ type: "content", content: { type: "resource_link", uri: pathToFileURL(path).href,
          name: basename(path), description: params.description } })
      }
    } else return undefined
    return { sessionId, update: { sessionUpdate: "tool_call", toolCallId: params.toolCallId,
      title: params.description, kind: "other", status: "completed", content, rawInput: params, _meta: meta,
    } }
  }
}
