import { execFileSync } from "node:child_process"
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { setTimeout } from "node:timers/promises"
import { AppStoreConnect } from "./app-store-connect.ts"

interface IosRelease {
  bundleId: string
  version: string
  buildNumber: string
  ipa: string
}

interface BuildUpload {
  id: string
  attributes?: {
    state?: {
      state?: "AWAITING_UPLOAD" | "PROCESSING" | "FAILED" | "COMPLETE"
      errors?: { code?: string; description?: string }[]
    }
  }
}

export interface PublishIosDependencies {
  api: Pick<AppStoreConnect, "list">
  upload: (ipa: string) => Promise<void>
  now: () => number
  sleep: (milliseconds: number) => Promise<void>
  log: (message: string) => void
  timeoutMs: number
  pollIntervalMs: number
}

function readRelease(directory: string): IosRelease {
  const release: IosRelease = JSON.parse(readFileSync(join(directory, "release.json"), "utf8"))
  for (const field of ["bundleId", "version", "buildNumber", "ipa"] as const) {
    if (typeof release?.[field] !== "string" || release[field].trim() === "") {
      throw new Error(`release.json must contain a nonempty ${field} string`)
    }
  }
  if (basename(release.ipa) !== release.ipa || !release.ipa.endsWith(".ipa")) {
    throw new Error("release.json ipa must name an IPA file in the artifact directory")
  }
  if (!statSync(join(directory, release.ipa)).isFile()) {
    throw new Error(`IPA is not a file: ${release.ipa}`)
  }
  return release
}

async function uploadIpa(ipa: string, env: NodeJS.ProcessEnv): Promise<void> {
  for (const name of ["APPLE_API_KEY_PATH", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"]) {
    if (!env[name]) throw new Error(`${name} is required to upload an iOS release`)
  }
  const keyDirectory = mkdtempSync(join(tmpdir(), "deskfleet-ios-upload-"))
  try {
    const keyPath = join(keyDirectory, `AuthKey_${env.APPLE_API_KEY_ID}.p8`)
    copyFileSync(env.APPLE_API_KEY_PATH!, keyPath)
    chmodSync(keyPath, 0o600)
    execFileSync("xcrun", [
      "altool", "--upload-app", "-f", ipa, "-t", "ios",
      "--api-key", env.APPLE_API_KEY_ID!, "--api-issuer", env.APPLE_API_ISSUER!,
    ], { stdio: "inherit", env: { ...env, API_PRIVATE_KEYS_DIR: keyDirectory } })
  } finally {
    rmSync(keyDirectory, { recursive: true, force: true })
  }
}

function selectUpload(uploads: BuildUpload[]): BuildUpload | undefined {
  // A failed delivery may be retried with the same version and build number.
  // Prefer an accepted or active delivery over an older failed attempt.
  return uploads.find(upload => upload.attributes?.state?.state === "COMPLETE")
    ?? uploads.find(upload => ["PROCESSING", "AWAITING_UPLOAD"].includes(upload.attributes?.state?.state ?? ""))
    ?? uploads[0]
}

function failureDetails(upload: BuildUpload): string {
  return upload.attributes?.state?.errors?.map(error =>
    [error.code, error.description].filter(Boolean).join(": "),
  ).filter(Boolean).join("\n") || "App Store Connect did not return error details."
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function publishIosRelease(
  artifactDirectory: string,
  overrides: Partial<PublishIosDependencies> = {},
): Promise<{ uploadId: string; uploaded: boolean }> {
  const directory = resolve(artifactDirectory)
  const release = readRelease(directory)
  const dependencies: PublishIosDependencies = {
    api: overrides.api ?? new AppStoreConnect(),
    upload: ipa => uploadIpa(ipa, process.env),
    now: Date.now,
    sleep: async milliseconds => { await setTimeout(milliseconds) },
    log: console.log,
    timeoutMs: 20 * 60 * 1000,
    pollIntervalMs: 15 * 1000,
    ...overrides,
  }
  const { api, upload, now, sleep, log, timeoutMs, pollIntervalMs } = dependencies
  const identity = `${release.bundleId} ${release.version} (${release.buildNumber})`
  const appQuery = new URLSearchParams({ "filter[bundleId]": release.bundleId, "fields[apps]": "bundleId" })
  const apps = await api.list<{ id: string }>(`/v1/apps?${appQuery}`)
  if (apps.length !== 1) {
    throw new Error(`Expected one App Store Connect app for ${release.bundleId}; found ${apps.length}`)
  }
  const uploadQuery = new URLSearchParams({
    "filter[platform]": "IOS",
    "filter[cfBundleShortVersionString]": release.version,
    "filter[cfBundleVersion]": release.buildNumber,
    "fields[buildUploads]": "state",
    limit: "200",
  })
  const uploadsPath = `/v1/apps/${apps[0]!.id}/buildUploads?${uploadQuery}`
  // A failed lookup is not evidence that this build has never been uploaded.
  let current = selectUpload(await api.list<BuildUpload>(uploadsPath))
  let uploaded = false
  let transportError: unknown
  if (!current) {
    log(`Uploading ${identity} to App Store Connect`)
    uploaded = true
    try {
      await upload(join(directory, release.ipa))
    } catch (error) {
      transportError = error
      log(`Upload command failed; checking App Store Connect before deciding the result: ${errorMessage(error)}`)
    }
  } else {
    log(`Found existing delivery for ${identity}; checking its processing status`)
  }

  const deadline = now() + timeoutMs
  let lastLookupError: unknown
  let lastState: string | undefined
  let shouldWait = Boolean(current)
  while (true) {
    if (current) {
      const state = current.attributes?.state?.state
      if (state === "COMPLETE") {
        log(`App Store Connect processing complete for ${identity} (delivery ${current.id})`)
        return { uploadId: current.id, uploaded }
      }
      if (state === "FAILED") {
        throw new Error(`App Store Connect processing failed for ${identity} (delivery ${current.id}). Fix the reported errors before retrying.\n${failureDetails(current)}`)
      }
      if (state !== "PROCESSING" && state !== "AWAITING_UPLOAD") {
        throw new Error(`Unknown App Store Connect processing state for delivery ${current.id}: ${String(state)}`)
      }
      if (state !== lastState) log(`App Store Connect status for ${identity}: ${state}`)
      lastState = state
    }
    if (now() >= deadline) {
      const details = [
        lastState ? `Last status: ${lastState}.` : "No delivery was confirmed.",
        transportError ? `Upload error: ${errorMessage(transportError)}` : "",
        lastLookupError ? `Status lookup error: ${errorMessage(lastLookupError)}` : "",
      ].filter(Boolean).join("\n")
      throw new Error(`Timed out waiting for App Store Connect processing of ${identity}. No additional upload was attempted.\n${details}`)
    }
    // Check immediately after the upload command, then give Apple time to process.
    if (shouldWait) {
      await sleep(Math.min(pollIntervalMs, deadline - now()))
    }
    shouldWait = true
    try {
      current = selectUpload(await api.list<BuildUpload>(uploadsPath))
      lastLookupError = undefined
    } catch (error) {
      lastLookupError = error
      log(`Could not query App Store Connect processing; will retry without uploading: ${errorMessage(error)}`)
    }
  }
}

if (import.meta.main) {
  const [directory, ...extra] = process.argv.slice(2)
  if (!directory || extra.length) {
    throw new Error("Usage: node scripts/publish-ios-release.ts <artifact-directory>")
  }
  await publishIosRelease(directory)
}
