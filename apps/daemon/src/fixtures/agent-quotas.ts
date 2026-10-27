import type { AdmissionRequest, AgentQuotaAuthority, SessionAdmission } from "../agent-quotas.ts"

/** Explicit local authority for tests; production always contacts the Team server. */
export class TestAgentQuotas implements AgentQuotaAuthority {
  limit: number | null = null
  capacity: number | null = null
  available = true
  checks = 0
  readonly admissions = new Map<string, SessionAdmission>()
  async turnLimit(): Promise<number | null> {
    this.checks++
    if (!this.available) throw new Error("Team allowance is unavailable")
    return this.limit
  }
  async reserve(request: AdmissionRequest): Promise<SessionAdmission> {
    const previous = this.admissions.get(request.operationId)
    if (previous) return { ...previous }
    const occupied = [...this.admissions.values()].filter(value => value.status !== "released").length
    if (this.capacity !== null && occupied >= this.capacity) throw new Error("Team Session allowance reached")
    const value: SessionAdmission = { admissionId: request.operationId, generation: request.operationId, status: "reserved", sessionId: request.sessionId ?? null }
    this.admissions.set(request.operationId, value)
    return { ...value }
  }
  async list(): Promise<SessionAdmission[]> { return [...this.admissions.values()].filter(value => value.status !== "released").map(value => ({ ...value })) }
  async confirm(generation: string, sessionId: string): Promise<void> {
    const value = this.admissions.get(generation)
    if (value && value.status !== "released") { value.status = "committed"; value.sessionId = sessionId }
  }
  async cancel(generation: string): Promise<void> {
    const value = this.admissions.get(generation)
    if (value?.status === "reserved") value.status = "released"
  }
  async release(generation: string, sessionId: string): Promise<void> {
    const value = this.admissions.get(generation)
    if (value?.sessionId === sessionId) value.status = "released"
  }
}
