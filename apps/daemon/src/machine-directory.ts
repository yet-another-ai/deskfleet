import { randomBytes, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { centralUrl, type MachineCredentials } from "./central-protocol.ts"

const REGISTRATIONS = "machine-registrations.json"
const IDENTITY = "machine-identity.json"

export interface MachineRegistration { serverUrl: string; teamId: string; directory: string }

async function readJson(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, "utf8")) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

async function saveJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp`
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 })
  await rename(temporary, path)
}

function validDirectory(value: unknown, testing: boolean): value is string {
  return value === "machine" || (testing && value === ".") || typeof value === "string" && /^machines\/[a-f0-9-]{36}$/u.test(value)
}

/** Adopt the old active catalog in place; generated checkouts retain their paths. */
export async function loadMachineRegistrations(hostDirectory: string, testing: boolean): Promise<{
  registrations: MachineRegistration[]; identityToken: string; initialDirectory: string
}> {
  await mkdir(hostDirectory, { recursive: true, mode: 0o700 })
  const saved = await readJson(join(hostDirectory, REGISTRATIONS))
  let initialDirectory = testing ? "." : "machine"
  let legacy: MachineCredentials | undefined
  if (saved === undefined) {
    const pointer = await readJson(join(hostDirectory, "active-machine.json"))
    const previous = testing ? "." : pointer === undefined ? "machine" : (pointer as { directory?: unknown }).directory
    if (!validDirectory(previous, testing)) throw new Error("Invalid active machine directory")
    initialDirectory = previous
    legacy = await readJson(join(hostDirectory, initialDirectory, "central.json")) as MachineCredentials | undefined
  }
  const savedIdentity = await readJson(join(hostDirectory, IDENTITY)) as { identityToken?: unknown } | undefined
  if (saved !== undefined && !savedIdentity) throw new Error("Machine identity is missing")
  const identityToken = savedIdentity === undefined ? legacy?.token ?? randomBytes(32).toString("hex") : savedIdentity.identityToken
  if (typeof identityToken !== "string" || !identityToken) throw new Error("Invalid machine identity token")
  if (!savedIdentity) await saveJson(join(hostDirectory, IDENTITY), { identityToken })

  let registrations: MachineRegistration[]
  if (saved === undefined) {
    registrations = legacy ? [{ serverUrl: centralUrl(legacy.serverUrl), teamId: legacy.teamId, directory: initialDirectory }] : []
    await saveMachineRegistrations(hostDirectory, registrations)
  } else {
    if (!Array.isArray(saved)) throw new Error("Invalid machine registrations")
    const keys = new Set<string>(), directories = new Set<string>()
    registrations = saved.map((value: unknown) => {
      if (!value || typeof value !== "object") throw new Error("Invalid machine registration")
      const record = value as Record<string, unknown>
      if (typeof record.serverUrl !== "string" || typeof record.teamId !== "string" || !record.teamId || !validDirectory(record.directory, testing)) {
        throw new Error("Invalid machine registration")
      }
      const registration = { serverUrl: centralUrl(record.serverUrl), teamId: record.teamId, directory: record.directory }
      const key = registrationKey(registration)
      if (keys.has(key) || directories.has(registration.directory)) throw new Error("Duplicate machine registration")
      keys.add(key); directories.add(registration.directory)
      return registration
    })
  }
  return { registrations, identityToken, initialDirectory }
}

export function registrationKey(target: { serverUrl: string; teamId: string }): string {
  return JSON.stringify([centralUrl(target.serverUrl), target.teamId])
}

export async function saveMachineRegistrations(hostDirectory: string, registrations: MachineRegistration[]): Promise<void> {
  await saveJson(join(hostDirectory, REGISTRATIONS), registrations)
}

export async function newMachineDirectory(hostDirectory: string): Promise<string> {
  const directory = `machines/${randomUUID()}`
  await mkdir(join(hostDirectory, directory), { recursive: true, mode: 0o700 })
  return directory
}
