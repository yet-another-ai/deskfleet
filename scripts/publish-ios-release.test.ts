import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import { publishIosRelease, type PublishIosDependencies } from "./publish-ios-release.ts"

function fixture(context: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "deskfleet-publish-ios-test-"))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  writeFileSync(join(directory, "release.json"), JSON.stringify({
    bundleId: "ai.yetanother.deskfleet", version: "0.15.0", buildNumber: "1", ipa: "App.ipa",
  }))
  writeFileSync(join(directory, "App.ipa"), "signed release fixture")
  return directory
}

function delivery(state: string, id = "delivery-1") {
  return {
    id,
    attributes: {
      state: {
        state,
        ...(state === "FAILED" ? { errors: [{ code: "INVALID_BINARY", description: "An entitlement is missing" }] } : {}),
      },
    },
  }
}

function scenario(steps: (unknown[] | Error)[], uploadError?: Error) {
  const requests: URL[] = []
  const uploads: string[] = []
  const messages: string[] = []
  let clock = 0
  let index = 0
  const dependencies: PublishIosDependencies = {
    api: {
      async list<T>(path: string): Promise<T[]> {
        const url = new URL(path, "https://api.appstoreconnect.apple.com")
        requests.push(url)
        if (url.pathname === "/v1/apps") return [{ id: "app-1" }] as T[]
        assert.equal(url.pathname, "/v1/apps/app-1/buildUploads")
        const response = steps[Math.min(index++, steps.length - 1)]!
        if (response instanceof Error) throw response
        return response as T[]
      },
    },
    async upload(ipa) {
      uploads.push(ipa)
      if (uploadError) throw uploadError
    },
    now: () => clock,
    sleep: async milliseconds => { clock += milliseconds },
    log: message => { messages.push(message) },
    timeoutMs: 40,
    pollIntervalMs: 10,
  }
  return { dependencies, requests, uploads, messages, elapsed: () => clock }
}

test("completed delivery skips uploading and uses the artifact's version identity", async context => {
  const directory = fixture(context)
  const run = scenario([[delivery("COMPLETE")]])
  assert.deepEqual(await publishIosRelease(directory, run.dependencies), { uploadId: "delivery-1", uploaded: false })
  assert.equal(run.uploads.length, 0)
  assert.equal(run.elapsed(), 0)
  assert.equal(run.requests[0]!.searchParams.get("filter[bundleId]"), "ai.yetanother.deskfleet")
  assert.equal(run.requests[1]!.searchParams.get("filter[cfBundleShortVersionString]"), "0.15.0")
  assert.equal(run.requests[1]!.searchParams.get("filter[cfBundleVersion]"), "1")
  assert.equal(run.requests[1]!.searchParams.get("filter[platform]"), "IOS")
})

test("a failed historical attempt does not hide an accepted or active retry", async context => {
  const directory = fixture(context)
  const completed = scenario([[delivery("FAILED", "old"), delivery("COMPLETE", "accepted")]])
  assert.deepEqual(await publishIosRelease(directory, completed.dependencies), { uploadId: "accepted", uploaded: false })
  const processing = scenario([
    [delivery("FAILED", "old"), delivery("PROCESSING", "retry")],
    [delivery("COMPLETE", "retry")],
  ])
  assert.deepEqual(await publishIosRelease(directory, processing.dependencies), { uploadId: "retry", uploaded: false })
  assert.equal(processing.uploads.length, 0)
  assert.equal(processing.elapsed(), 10)
})

test("an existing delivery awaiting upload is checked without sending a duplicate", async context => {
  const run = scenario([[delivery("AWAITING_UPLOAD")], [delivery("PROCESSING")], [delivery("COMPLETE")]])
  assert.equal((await publishIosRelease(fixture(context), run.dependencies)).uploaded, false)
  assert.equal(run.uploads.length, 0)
  assert.equal(run.elapsed(), 20)
})

test("new delivery uploads once and waits through delayed visibility and processing", async context => {
  const directory = fixture(context)
  const run = scenario([[], [], [delivery("PROCESSING")], [delivery("COMPLETE")]])
  assert.deepEqual(await publishIosRelease(directory, run.dependencies), { uploadId: "delivery-1", uploaded: true })
  assert.deepEqual(run.uploads, [join(directory, "App.ipa")])
  assert.equal(run.elapsed(), 20)
})

test("a transport failure after Apple accepts the IPA is recovered by checking its status", async context => {
  const run = scenario([[], [delivery("PROCESSING")], [delivery("COMPLETE")]], new Error("connection closed"))
  assert.equal((await publishIosRelease(fixture(context), run.dependencies)).uploadId, "delivery-1")
  assert.equal(run.uploads.length, 1)
  assert.ok(run.messages.some(message => message.includes("checking App Store Connect")))
})

test("status lookup failures after upload are retried without uploading again", async context => {
  const run = scenario([[], new Error("service unavailable"), [], [delivery("COMPLETE")]])
  await publishIosRelease(fixture(context), run.dependencies)
  assert.equal(run.uploads.length, 1)
  assert.equal(run.elapsed(), 20)
})

test("an unavailable preflight lookup does not authorize an upload", async context => {
  const run = scenario([new Error("App Store Connect 503")])
  await assert.rejects(publishIosRelease(fixture(context), run.dependencies), /App Store Connect 503/)
  assert.equal(run.uploads.length, 0)
})

test("failed processing reports Apple's errors both before and after uploading", async context => {
  const directory = fixture(context)
  for (const steps of [[[delivery("FAILED")]], [[], [delivery("FAILED")]]]) {
    const run = scenario(steps)
    await assert.rejects(publishIosRelease(directory, run.dependencies), /INVALID_BINARY: An entitlement is missing/)
    assert.equal(run.uploads.length, steps.length - 1)
    assert.equal(run.elapsed(), 0)
  }
})

test("processing and uncertain transport results fail within the polling deadline", async context => {
  const directory = fixture(context)
  for (const steps of [
    [[delivery("PROCESSING")]],
    [[], []],
    [[], new Error("status service unavailable")],
  ]) {
    const run = scenario(steps, new Error("upload connection lost"))
    await assert.rejects(publishIosRelease(directory, run.dependencies), /Timed out.*No additional upload was attempted/)
    assert.equal(run.elapsed(), 40)
    assert.equal(run.uploads.length, steps.length - 1)
  }
})

test("unknown processing states cannot be mistaken for successful publication", async context => {
  const run = scenario([[delivery("UNRECOGNIZED")]])
  await assert.rejects(publishIosRelease(fixture(context), run.dependencies), /Unknown App Store Connect processing state/)
  assert.equal(run.uploads.length, 0)
})
