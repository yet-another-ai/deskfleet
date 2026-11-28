import type { SuperAgentApi } from "@deskfleet/client/desktop-api"
import type { FollowUpAuthReceipt } from "@deskfleet/protocol/super-agent"

const INSTALLATION_ID_KEY = "deskfleet.workspace-agent.installation-id"
const FOLLOW_UP_STATE_KEY = "deskfleet.workspace-agent.follow-up-state"
const FOLLOW_UP_GRANTS_KEY = "deskfleet.workspace-agent.follow-up-grants"
const FOLLOW_UP_PENDING_REVOCATIONS_KEY = "deskfleet.workspace-agent.follow-up-pending-revocations"

export interface FollowUpScope {
  serverUrl?: string
  userId?: string
  teamId?: string
  machineId?: string
}

export interface StoredFollowUpMachineState {
  installationId: string
  knownAuthVersion: number
  authorized: boolean
  /** True when THIS viewing installation itself holds an active grant on the target machine. */
  deviceAuthorized?: boolean
  lastConfirmedAt?: string
}

export interface StoredFollowUpGrant {
  installationId: string
  knownAuthVersion: number
  grantedAt: string
  machineName?: string
}

export interface StoredPendingRevocation {
  installationId: string
  knownAuthVersion: number
  requestedAt: string
  machineName?: string
}

export interface FollowUpApiHandle {
  api: SuperAgentApi
  dispose?: () => void
}

export type FollowUpApiResolver = (scope: FollowUpScope) => Promise<FollowUpApiHandle | undefined>

function scopeKey(scope: FollowUpScope): string {
  return JSON.stringify([scope.serverUrl ?? "", scope.userId ?? "", scope.teamId ?? "", scope.machineId ?? ""])
}

function parseScopeKey(key: string): FollowUpScope | undefined {
  try {
    const parsed = JSON.parse(key)
    if (!Array.isArray(parsed) || parsed.length !== 4) return undefined
    const [serverUrl, userId, teamId, machineId] = parsed as [string, string, string, string]
    return { serverUrl, userId, teamId, machineId }
  } catch { return undefined }
}

function readRecord<T>(storageKey: string): Record<string, T> {
  if (typeof localStorage === "undefined") return {}
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, T> : {}
  } catch { return {} }
}

function writeRecord<T>(storageKey: string, map: Record<string, T>): void {
  if (typeof localStorage === "undefined") return
  try {
    if (Object.keys(map).length === 0) localStorage.removeItem(storageKey)
    else localStorage.setItem(storageKey, JSON.stringify(map))
  } catch { /* ignore storage quota errors */ }
}

/** Persistent per-installation identifier, distinct from login session deviceId. */
export function getClientInstallationId(): string {
  if (typeof localStorage === "undefined") return "ephemeral-installation"
  const existing = localStorage.getItem(INSTALLATION_ID_KEY)
  if (existing && existing.trim()) return existing.trim()
  const created = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `inst-${Date.now()}-${Math.random().toString(36).slice(2)}`
  try { localStorage.setItem(INSTALLATION_ID_KEY, created) } catch { /* ignore */ }
  return created
}

export function getStoredFollowUpState(scope: FollowUpScope): StoredFollowUpMachineState | undefined {
  return readRecord<StoredFollowUpMachineState>(FOLLOW_UP_STATE_KEY)[scopeKey(scope)]
}

export function getPendingFollowUpRevocation(scope: FollowUpScope): StoredPendingRevocation | undefined {
  return readRecord<StoredPendingRevocation>(FOLLOW_UP_PENDING_REVOCATIONS_KEY)[scopeKey(scope)]
}

export function hasPendingFollowUpRevocation(scope: FollowUpScope): boolean {
  return !!getPendingFollowUpRevocation(scope)
}

/** True iff this installation currently holds an enabled grant for `scope` with no pending revocation. */
export function hasActiveGrantForInstallation(scope: FollowUpScope): boolean {
  const key = scopeKey(scope)
  if (readRecord<StoredPendingRevocation>(FOLLOW_UP_PENDING_REVOCATIONS_KEY)[key]) return false
  return !!readRecord<StoredFollowUpGrant>(FOLLOW_UP_GRANTS_KEY)[key]
}

function saveMachineState(scope: FollowUpScope, value: StoredFollowUpMachineState): void {
  const map = readRecord<StoredFollowUpMachineState>(FOLLOW_UP_STATE_KEY)
  map[scopeKey(scope)] = value
  writeRecord(FOLLOW_UP_STATE_KEY, map)
}

function saveGrant(scope: FollowUpScope, grant: StoredFollowUpGrant): void {
  const map = readRecord<StoredFollowUpGrant>(FOLLOW_UP_GRANTS_KEY)
  map[scopeKey(scope)] = grant
  writeRecord(FOLLOW_UP_GRANTS_KEY, map)
}

function removeGrant(scope: FollowUpScope): void {
  const map = readRecord<StoredFollowUpGrant>(FOLLOW_UP_GRANTS_KEY)
  const key = scopeKey(scope)
  if (key in map) {
    delete map[key]
    writeRecord(FOLLOW_UP_GRANTS_KEY, map)
  }
}

function savePendingRevocation(scope: FollowUpScope, pending: StoredPendingRevocation): void {
  const map = readRecord<StoredPendingRevocation>(FOLLOW_UP_PENDING_REVOCATIONS_KEY)
  map[scopeKey(scope)] = pending
  writeRecord(FOLLOW_UP_PENDING_REVOCATIONS_KEY, map)
}

function removePendingRevocation(scope: FollowUpScope): void {
  const map = readRecord<StoredPendingRevocation>(FOLLOW_UP_PENDING_REVOCATIONS_KEY)
  const key = scopeKey(scope)
  if (key in map) {
    delete map[key]
    writeRecord(FOLLOW_UP_PENDING_REVOCATIONS_KEY, map)
  }
}

/**
 * Clear ONLY non-authoritative account UI cache on sign-out.
 * Durable unconfirmed pending revocations remain persisted (strictly scoped by serverUrl + userId)
 * so they flush automatically once the same account reconnects / signs back in, while remaining
 * completely isolated from other accounts.
 */
export function clearFollowUpCacheForAccount(serverUrl: string | undefined, userId: string | undefined): void {
  const map = readRecord<StoredFollowUpMachineState>(FOLLOW_UP_STATE_KEY)
  let changed = false
  for (const key of Object.keys(map)) {
    const parsed = parseScopeKey(key)
    if (parsed && parsed.serverUrl === (serverUrl ?? "") && parsed.userId === (userId ?? "")) {
      delete map[key]
      changed = true
    }
  }
  if (changed) writeRecord(FOLLOW_UP_STATE_KEY, map)
}

function installationEnabledInReceipt(receipt: FollowUpAuthReceipt, installationId: string): boolean {
  if (!receipt.authorized) return false
  const devices = receipt.summary?.devices
  if (!Array.isArray(devices) || devices.length === 0) return false
  return devices.some(device => device.installationId === installationId && device.enabled)
}

/**
 * Sync latest authVersion first and flush any persisted offline revocation before allowing new grants.
 * Ensures a stale device reconnect cannot re-open an authorization revoked elsewhere.
 */
export async function syncAndFlushPendingRevocation(
  api: SuperAgentApi | undefined,
  scope: FollowUpScope,
): Promise<FollowUpAuthReceipt | undefined> {
  if (!api?.followUpAuth) return undefined
  const installationId = getClientInstallationId()
  const pending = getPendingFollowUpRevocation(scope)
  const latest = await api.followUpAuth({ action: "status", installationId })
  if (pending) {
    const receipt = await api.followUpAuth({
      action: "disable",
      installationId: pending.installationId,
      expectedAuthVersion: latest.authVersion,
    })
    removePendingRevocation(scope)
    removeGrant(scope)
    saveMachineState(scope, {
      installationId,
      knownAuthVersion: receipt.authVersion,
      authorized: receipt.authorized,
      deviceAuthorized: false,
      lastConfirmedAt: new Date().toISOString(),
    })
    return receipt
  }
  const hasDevices = Array.isArray(latest.summary?.devices) && latest.summary.devices.length > 0
  const deviceAuthorized = hasDevices
    ? installationEnabledInReceipt(latest, installationId)
    : (latest.authorized && hasActiveGrantForInstallation(scope))
  if (deviceAuthorized) {
    saveGrant(scope, {
      installationId,
      knownAuthVersion: latest.authVersion,
      grantedAt: readRecord<StoredFollowUpGrant>(FOLLOW_UP_GRANTS_KEY)[scopeKey(scope)]?.grantedAt ?? new Date().toISOString(),
    })
  } else if (hasDevices || !latest.authorized) {
    removeGrant(scope)
  }
  saveMachineState(scope, {
    installationId,
    knownAuthVersion: latest.authVersion,
    authorized: latest.authorized,
    deviceAuthorized,
    lastConfirmedAt: new Date().toISOString(),
  })
  return latest
}

/** Explicitly enable background follow-up for this installation on the target execution machine. */
export async function enableFollowUpOnMachine(
  api: SuperAgentApi | undefined,
  scope: FollowUpScope,
  info: { deviceLabel?: string; platform?: string; machineName?: string } = {},
): Promise<FollowUpAuthReceipt> {
  if (!api?.followUpAuth) throw new Error("Target machine does not support proactive background follow-up")
  const installationId = getClientInstallationId()
  // Always sync latest authVersion before enabling; flush any pending revocation first.
  const synced = await syncAndFlushPendingRevocation(api, scope)
  const receipt = await api.followUpAuth({
    action: "enable",
    installationId,
    deviceLabel: info.deviceLabel,
    platform: info.platform,
    expectedAuthVersion: synced?.authVersion,
  })
  const now = new Date().toISOString()
  if (receipt.status !== "stale_ignored" && receipt.authorized) {
    removePendingRevocation(scope)
    saveGrant(scope, {
      installationId,
      knownAuthVersion: receipt.authVersion,
      grantedAt: now,
      ...(info.machineName ? { machineName: info.machineName } : {}),
    })
  }
  saveMachineState(scope, {
    installationId,
    knownAuthVersion: receipt.authVersion,
    authorized: receipt.authorized,
    deviceAuthorized: receipt.status !== "stale_ignored" && receipt.authorized,
    lastConfirmedAt: now,
  })
  return receipt
}

/**
 * Enable unified Super Agent session + schedule takeover ("让super agent 接管所有会话") on the
 * target execution machine, completing required background authorization in the same step.
 * Never records an active grant if authorization fails or is rejected as stale.
 */
export async function enableTakeoverOnMachine(
  api: SuperAgentApi | undefined,
  scope: FollowUpScope,
  info: { deviceLabel?: string; platform?: string; machineName?: string } = {},
): Promise<FollowUpAuthReceipt> {
  if (!api?.followUpAuth) throw new Error("Target machine does not support proactive background follow-up")
  const installationId = getClientInstallationId()
  const synced = await syncAndFlushPendingRevocation(api, scope)
  const receipt = await api.followUpAuth({
    action: "enable",
    installationId,
    deviceLabel: info.deviceLabel,
    platform: info.platform,
    expectedAuthVersion: synced?.authVersion,
    takeoverAllSessions: true,
  })
  const now = new Date().toISOString()
  const active = receipt.status !== "stale_ignored" && receipt.authorized && receipt.summary?.takeoverAllSessions === true
  if (active) {
    removePendingRevocation(scope)
    saveGrant(scope, {
      installationId,
      knownAuthVersion: receipt.authVersion,
      grantedAt: now,
      ...(info.machineName ? { machineName: info.machineName } : {}),
    })
  }
  saveMachineState(scope, {
    installationId,
    knownAuthVersion: receipt.authVersion,
    authorized: receipt.authorized,
    deviceAuthorized: receipt.status !== "stale_ignored" && receipt.authorized,
    lastConfirmedAt: now,
  })
  return receipt
}

/** Disable unified takeover across all projects without closing sessions or cancelling schedules. */
export async function disableTakeoverOnMachine(
  api: SuperAgentApi | undefined,
  scope: FollowUpScope,
): Promise<FollowUpAuthReceipt> {
  if (!api?.followUpAuth) throw new Error("Target machine does not support proactive background follow-up")
  const installationId = getClientInstallationId()
  const receipt = await api.followUpAuth({
    action: "configure",
    takeoverAllSessions: false,
  })
  saveMachineState(scope, {
    installationId,
    knownAuthVersion: receipt.authVersion,
    authorized: receipt.authorized,
    deviceAuthorized: installationEnabledInReceipt(receipt, installationId),
    lastConfirmedAt: new Date().toISOString(),
  })
  return receipt
}

/**
 * Disable this device's grant on one target execution machine.
 * Persists a durable pending revocation immediately (in a storage key separate from account UI cache)
 * so offline toggles and offline sign-outs retain their revocation until the target host confirms.
 */
export async function disableFollowUpOnMachine(
  api: SuperAgentApi | undefined,
  scope: FollowUpScope,
  info: { deviceLabel?: string; platform?: string; machineName?: string } = {},
): Promise<{ confirmed: boolean; receipt?: FollowUpAuthReceipt }> {
  const installationId = getClientInstallationId()
  const prior = getStoredFollowUpState(scope)
  const priorGrant = readRecord<StoredFollowUpGrant>(FOLLOW_UP_GRANTS_KEY)[scopeKey(scope)]
  const knownAuthVersion = Math.max(prior?.knownAuthVersion ?? 0, priorGrant?.knownAuthVersion ?? 0)
  const now = new Date().toISOString()
  removeGrant(scope)
  savePendingRevocation(scope, {
    installationId,
    knownAuthVersion,
    requestedAt: now,
    ...(info.machineName ?? priorGrant?.machineName ? { machineName: info.machineName ?? priorGrant?.machineName } : {}),
  })
  saveMachineState(scope, {
    installationId,
    knownAuthVersion,
    authorized: false,
    deviceAuthorized: false,
  })
  if (!api?.followUpAuth) return { confirmed: false }
  try {
    const receipt = await api.followUpAuth({
      action: "disable",
      installationId,
      deviceLabel: info.deviceLabel,
      platform: info.platform,
    })
    removePendingRevocation(scope)
    removeGrant(scope)
    saveMachineState(scope, {
      installationId,
      knownAuthVersion: receipt.authVersion,
      authorized: receipt.authorized,
      deviceAuthorized: false,
      lastConfirmedAt: new Date().toISOString(),
    })
    return { confirmed: true, receipt }
  } catch {
    // Keep pending revocation durably persisted until the execution machine confirms on reconnect.
    return { confirmed: false }
  }
}

/** Stop ALL proactive follow-up grants for the signed-in user on this execution machine. */
export async function revokeAllFollowUpOnMachine(
  api: SuperAgentApi | undefined,
  scope: FollowUpScope,
): Promise<FollowUpAuthReceipt> {
  if (!api?.followUpAuth) throw new Error("Target machine does not support proactive background follow-up")
  const installationId = getClientInstallationId()
  const receipt = await api.followUpAuth({ action: "revoke_all", installationId })
  removePendingRevocation(scope)
  removeGrant(scope)
  saveMachineState(scope, {
    installationId,
    knownAuthVersion: receipt.authVersion,
    authorized: false,
    deviceAuthorized: false,
    lastConfirmedAt: new Date().toISOString(),
  })
  return receipt
}

/** Return all unconfirmed pending revocations for this account across all teams and machines. */
export function listPendingRevocationsForAccount(
  serverUrl: string | undefined,
  userId: string | undefined,
): { scope: FollowUpScope; pending: StoredPendingRevocation }[] {
  const map = readRecord<StoredPendingRevocation>(FOLLOW_UP_PENDING_REVOCATIONS_KEY)
  const out: { scope: FollowUpScope; pending: StoredPendingRevocation }[] = []
  for (const [key, pending] of Object.entries(map)) {
    const scope = parseScopeKey(key)
    if (scope && scope.serverUrl === (serverUrl ?? "") && scope.userId === (userId ?? "")) {
      out.push({ scope, pending })
    }
  }
  return out
}

/** Return all machine scopes on which this installation has an active grant or pending revocation for this account. */
export function listAuthorizedFollowUpScopes(
  serverUrl: string | undefined,
  userId: string | undefined,
): { scope: FollowUpScope; grant?: StoredFollowUpGrant; pending?: StoredPendingRevocation }[] {
  const grants = readRecord<StoredFollowUpGrant>(FOLLOW_UP_GRANTS_KEY)
  const pendings = readRecord<StoredPendingRevocation>(FOLLOW_UP_PENDING_REVOCATIONS_KEY)
  const keys = new Set([...Object.keys(grants), ...Object.keys(pendings)])
  const out: { scope: FollowUpScope; grant?: StoredFollowUpGrant; pending?: StoredPendingRevocation }[] = []
  for (const key of keys) {
    const scope = parseScopeKey(key)
    if (scope && scope.serverUrl === (serverUrl ?? "") && scope.userId === (userId ?? "")) {
      out.push({ scope, grant: grants[key], pending: pendings[key] })
    }
  }
  return out
}

export interface MultiMachineRevocationOutcome {
  results: { scope: FollowUpScope; confirmed: boolean; receipt?: FollowUpAuthReceipt }[]
  allConfirmed: boolean
  pendingCount: number
  anyOtherDeviceActive: boolean
  maxOtherActiveDevices: number
}

/**
 * Revoke this installation's background follow-up grant across EVERY team and execution machine
 * it previously authorized for `(serverUrl, userId)`, including machines never opened in the
 * current login session. Offline machines retain durable pending revocations until confirmed.
 */
export async function revokeAllScopesForInstallation(options: {
  serverUrl?: string
  userId?: string
  resolveApi: FollowUpApiResolver
  extraScopes?: FollowUpScope[]
  info?: { deviceLabel?: string; platform?: string }
}): Promise<MultiMachineRevocationOutcome> {
  const scopesByKey = new Map<string, FollowUpScope>()
  for (const entry of listAuthorizedFollowUpScopes(options.serverUrl, options.userId)) {
    scopesByKey.set(scopeKey(entry.scope), entry.scope)
  }
  for (const extra of options.extraScopes ?? []) {
    const normalized: FollowUpScope = {
      serverUrl: extra.serverUrl ?? options.serverUrl,
      userId: extra.userId ?? options.userId,
      teamId: extra.teamId,
      machineId: extra.machineId,
    }
    if (!normalized.machineId && !normalized.teamId) {
      // Standalone single-machine fallback without account/team context
      scopesByKey.set(scopeKey(normalized), normalized)
    } else if (normalized.machineId) {
      scopesByKey.set(scopeKey(normalized), normalized)
    }
  }

  const results = await Promise.all([...scopesByKey.values()].map(async scope => {
    let handle: FollowUpApiHandle | undefined
    try {
      handle = await options.resolveApi(scope)
      const outcome = await disableFollowUpOnMachine(handle?.api, scope, options.info)
      return { scope, confirmed: outcome.confirmed, receipt: outcome.receipt }
    } catch {
      const outcome = await disableFollowUpOnMachine(undefined, scope, options.info)
      return { scope, confirmed: outcome.confirmed }
    } finally {
      try { handle?.dispose?.() } catch { /* ignore cleanup errors */ }
    }
  }))

  const pendingCount = results.filter(r => !r.confirmed).length
  let maxOtherActiveDevices = 0
  for (const r of results) {
    if (r.confirmed && r.receipt && !r.receipt.stoppedAllBackground) {
      maxOtherActiveDevices = Math.max(maxOtherActiveDevices, r.receipt.activeDeviceCount)
    }
  }
  return {
    results,
    allConfirmed: pendingCount === 0,
    pendingCount,
    anyOtherDeviceActive: maxOtherActiveDevices > 0,
    maxOtherActiveDevices,
  }
}

/**
 * Flush ALL persisted offline revocations belonging to `(serverUrl, userId)` across every team
 * and execution machine (even if the user has not opened that machine in the current session).
 */
export async function flushPendingRevocationsForAccount(options: {
  serverUrl?: string
  userId?: string
  resolveApi: FollowUpApiResolver
}): Promise<{ scope: FollowUpScope; confirmed: boolean; receipt?: FollowUpAuthReceipt }[]> {
  const pendings = listPendingRevocationsForAccount(options.serverUrl, options.userId)
  if (!pendings.length) return []
  return Promise.all(pendings.map(async ({ scope }) => {
    let handle: FollowUpApiHandle | undefined
    try {
      handle = await options.resolveApi(scope)
      if (!handle?.api?.followUpAuth) return { scope, confirmed: false }
      const receipt = await syncAndFlushPendingRevocation(handle.api, scope)
      return { scope, confirmed: !hasPendingFollowUpRevocation(scope), receipt }
    } catch {
      return { scope, confirmed: false }
    } finally {
      try { handle?.dispose?.() } catch { /* ignore cleanup errors */ }
    }
  }))
}
