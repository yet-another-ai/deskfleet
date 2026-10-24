import * as acp from "@agentclientprotocol/sdk"

export function isSecretElicitationField(property: acp.ElicitationPropertySchema): boolean {
  const meta = property._meta
  const codex = typeof meta === "object" && meta !== null && "codex" in meta ? meta.codex : undefined
  return typeof codex === "object" && codex !== null && "isSecret" in codex && codex.isSecret === true
}

function validFormat(value: string, format: acp.StringFormat): boolean {
  if (format === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)
  if (format === "uri") {
    try { return !!new URL(value).protocol } catch { return false }
  }
  if (format === "date") {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false
    const parsed = new Date(value)
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
  }
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/iu.test(value) && Number.isFinite(Date.parse(value))
}

function validProperty(property: acp.ElicitationPropertySchema, value: unknown): boolean {
  if (acp.ElicitationPropertySchema.isString(property)) {
    if (typeof value !== "string") return false
    const length = [...value].length
    if (property.minLength != null && length < property.minLength || property.maxLength != null && length > property.maxLength) return false
    if (property.enum && !property.enum.includes(value)) return false
    if (property.oneOf && !property.oneOf.some(option => option.const === value)) return false
    if (property.pattern && !new RegExp(property.pattern, "u").test(value)) return false
    return !property.format || validFormat(value, property.format)
  }
  if (acp.ElicitationPropertySchema.isNumber(property) || acp.ElicitationPropertySchema.isInteger(property)) {
    if (typeof value !== "number" || !Number.isFinite(value) || property.type === "integer" && !Number.isSafeInteger(value)) return false
    return !(property.minimum != null && value < property.minimum || property.maximum != null && value > property.maximum)
  }
  if (acp.ElicitationPropertySchema.isBoolean(property)) return typeof value === "boolean"
  if (acp.ElicitationPropertySchema.isArray(property)) {
    if (!Array.isArray(value) || !value.every(item => typeof item === "string") || new Set(value).size !== value.length) return false
    if (property.minItems != null && value.length < property.minItems || property.maxItems != null && value.length > property.maxItems) return false
    const items = property.items
    const choices = acp.MultiSelectItems.isString(items) ? items.enum
      : acp.MultiSelectItems.isTitled(items) ? items.anyOf.map(option => option.const) : undefined
    return !!choices && value.every(item => choices.includes(item))
  }
  return false
}

/** Validates actual answers against the provider schema without including answers in errors. */
export function validateElicitationResponse(request: acp.CreateElicitationRequest, value: unknown): acp.CreateElicitationResponse {
  if (!value || typeof value !== "object" || !("action" in value)) throw new Error("Invalid question response")
  if (value.action === "decline" || value.action === "cancel") return { action: value.action }
  if (value.action !== "accept" || !acp.CreateElicitationRequest.isForm(request)) throw new Error("Invalid question response")
  const content = "content" in value ? value.content ?? {} : {}
  if (!content || typeof content !== "object" || Array.isArray(content)) throw new Error("Question answers must be an object")
  const properties = request.requestedSchema.properties ?? {}
  for (const name of request.requestedSchema.required ?? []) {
    if (!Object.hasOwn(content, name)) throw new Error(`An answer is required for ${name}`)
  }
  for (const [name, answer] of Object.entries(content)) {
    const property = Object.hasOwn(properties, name) ? properties[name] : undefined
    if (!property) throw new Error("Unknown question field")
    // A provider may supply an invalid regular expression. Do not expose its
    // contents or accept an answer without checking that constraint.
    let valid = false
    try { valid = validProperty(property, answer) } catch {}
    if (!valid) throw new Error(`Invalid answer for ${name}`)
  }
  return { action: "accept", content: content as Record<string, acp.ElicitationContentValue> }
}

export function redactElicitationResponse(request: acp.CreateElicitationRequest, response: acp.CreateElicitationResponse): acp.CreateElicitationResponse {
  if (!acp.CreateElicitationRequest.isForm(request) || !acp.CreateElicitationResponse.isAccept(response) || !response.content) return response
  const properties = request.requestedSchema.properties ?? {}
  return { action: "accept", content: Object.fromEntries(Object.entries(response.content)
    .map(([name, value]) => [name, properties[name] && isSecretElicitationField(properties[name]) ? "[redacted]" : value])) }
}

export function redactElicitationRequest(request: acp.CreateElicitationRequest): acp.CreateElicitationRequest {
  if (!acp.CreateElicitationRequest.isForm(request)) return request
  return { ...request, requestedSchema: { ...request.requestedSchema,
    properties: Object.fromEntries(Object.entries(request.requestedSchema.properties ?? {}).map(([name, property]) => {
      if (!isSecretElicitationField(property)) return [name, property]
      const { default: _default, ...withoutDefault } = property
      return [name, withoutDefault]
    })),
  } }
}
