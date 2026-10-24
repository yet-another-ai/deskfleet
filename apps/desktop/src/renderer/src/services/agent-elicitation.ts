import type { AgentElicitation } from "../../../../../daemon/src/agent-protocol.ts"
import { isSecretElicitationField } from "../../../../../daemon/src/agent-elicitation-protocol.ts"

export type ElicitationValue = string | number | boolean | string[]
export type ElicitationDraft = Record<string, ElicitationValue>
export interface ElicitationChoice { value: string; title: string; description?: string }
export interface ElicitationField {
  id: string
  title: string
  description?: string
  type: string
  required: boolean
  secret: boolean
  choices: ElicitationChoice[]
  default?: ElicitationValue
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  pattern?: string
  format?: string
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const text = (value: unknown) => typeof value === "string" ? value : undefined
const number = (value: unknown) => typeof value === "number" ? value : undefined

function choices(schema: Record<string, unknown>, titled: string): ElicitationChoice[] {
  if (Array.isArray(schema[titled])) return schema[titled].filter(record).flatMap(option => typeof option.const === "string" ? [{ value: option.const, title: text(option.title) ?? option.const, description: text(option.description) }] : [])
  return Array.isArray(schema.enum) ? schema.enum.filter((value): value is string => typeof value === "string").map(value => ({ value, title: value })) : []
}

/** Presentation of ACP's primitive form schema; the daemon owns response validation. */
export function elicitationForm(request: AgentElicitation["request"]): { title?: string; description?: string; fields: ElicitationField[] } | null {
  if (request.mode !== "form" || !record(request.requestedSchema)) return null
  const schema = request.requestedSchema
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  const fields = Object.entries(record(schema.properties) ? schema.properties : {}).flatMap(([id, property]) => {
    if (!record(property) || typeof property.type !== "string") return []
    const field: ElicitationField = {
      id, title: text(property.title) ?? id, description: text(property.description), type: property.type,
      required: required.has(id), secret: isSecretElicitationField({ ...property, type: property.type }),
      choices: property.type === "array" && record(property.items) ? choices(property.items, "anyOf") : choices(property, "oneOf"),
      minimum: number(property.minimum), maximum: number(property.maximum), minLength: number(property.minLength), maxLength: number(property.maxLength),
      pattern: text(property.pattern), format: text(property.format),
    }
    const value = property.default
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || Array.isArray(value) && value.every(item => typeof item === "string")) field.default = Array.isArray(value) ? [...value] : value
    return [field]
  })
  return { title: text(schema.title), description: text(schema.description), fields }
}

export function elicitationDefaults(fields: ElicitationField[]): ElicitationDraft {
  return Object.fromEntries(fields.flatMap(field => field.default === undefined ? [] : [[field.id, Array.isArray(field.default) ? [...field.default] : field.default]]))
}

export function elicitationContent(fields: ElicitationField[], draft: ElicitationDraft): ElicitationDraft {
  return Object.fromEntries(fields.flatMap(field => {
    const value = draft[field.id]
    if (value === undefined || value === "") return []
    return [[field.id, ["number", "integer"].includes(field.type) && typeof value === "string" ? Number(value) : value]]
  }))
}

export function elicitationInputType(field: ElicitationField): string {
  if (field.secret) return "password"
  if (field.type === "number" || field.type === "integer") return "number"
  if (field.format === "email") return "email"
  if (field.format === "uri") return "url"
  if (field.format === "date") return "date"
  return "text"
}
