import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { type TestContext } from "node:test"
import { iosRelease, packageIosRelease, runLoggedCommand } from "./package-ios-release.ts"

const signing = {
  APPLE_TEAM_ID: "TESTTEAM01",
  DESKFLEET_IOS_SIGNING_IDENTITY: "A".repeat(40),
  DESKFLEET_IOS_APP_PROFILE_UUID: "11111111-1111-1111-1111-111111111111",
  DESKFLEET_IOS_BROADCAST_PROFILE_UUID: "22222222-2222-2222-2222-222222222222",
}

function fixture(context: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "deskfleet-ios-release-"))
  context.after(() => rmSync(root, { recursive: true, force: true }))
  const app = join(root, "apps/web/ios/App")
  mkdirSync(app, { recursive: true })
  return { root, app, env: { IOS_VERSION_NAME: "0.16.0-rc.1", GITHUB_RUN_NUMBER: "1234", GITHUB_RUN_ATTEMPT: "2" } }
}

test("iOS versions retain the marketing version and allocate a build once per workflow attempt", () => {
  assert.deepEqual(iosRelease("0.16.0-rc.1", { GITHUB_RUN_NUMBER: "1234", GITHUB_RUN_ATTEMPT: "2" }), {
    bundleId: "ai.yetanother.deskfleet", version: "0.16.0", buildNumber: "1234.2", ipa: "App.ipa",
  })
  assert.equal(iosRelease("0.16.0", { GITHUB_RUN_NUMBER: "1234", GITHUB_RUN_ATTEMPT: "3" }).buildNumber, "1234.3")
  assert.equal(iosRelease("0.16.0", { GITHUB_RUN_NUMBER: "1235", GITHUB_RUN_ATTEMPT: "1" }).buildNumber, "1235.1")
  assert.equal(iosRelease("0.16.0", { IOS_BUILD_NUMBER: " 7.4.2 ", GITHUB_RUN_NUMBER: "1234" }).buildNumber, "7.4.2")
  assert.equal(iosRelease("0.16.0", {}).buildNumber, "1")
  for (const env of [{ GITHUB_RUN_NUMBER: "1" }, { GITHUB_RUN_ATTEMPT: "1" }, { GITHUB_RUN_NUMBER: "1", GITHUB_RUN_ATTEMPT: "0" }]) {
    assert.throws(() => iosRelease("0.16.0", env), /must both be positive integers/)
  }
  for (const buildNumber of ["0", "-1", "1.2.3.4", "1.02", "2-beta"]) {
    assert.throws(() => iosRelease("0.16.0", { IOS_BUILD_NUMBER: buildNumber }), /IOS_BUILD_NUMBER/)
  }
  assert.throws(() => iosRelease("v0.16.0", {}), /marketing version/)
})

test("manual archive and export reuse the prepared identity and both profiles without contacting Apple", async context => {
  const { root, app, env } = fixture(context)
  const calls: string[][] = []
  let options = ""
  await packageIosRelease(root, true, { ...env, ...signing }, async (command, args, cwd, logPath) => {
    assert.equal(command, "xcodebuild")
    assert.equal(cwd, app)
    calls.push(args)
    writeFileSync(logPath, "xcodebuild fixture\n")
    if (args.includes("-exportArchive")) {
      options = readFileSync(join(app, "ExportOptions.plist"), "utf8")
      writeFileSync(join(app, "output/App.ipa"), "signed IPA fixture")
    } else {
      mkdirSync(join(app, "App.xcarchive"))
      mkdirSync(join(app, "diagnostics/archive.xcresult"))
    }
  })
  assert.equal(calls.length, 2)
  const archive = calls[0]!
  assert.ok(archive.includes("MARKETING_VERSION=0.16.0"))
  assert.ok(archive.includes("CURRENT_PROJECT_VERSION=1234.2"))
  assert.ok(archive.includes(`DESKFLEET_IOS_SIGNING_IDENTITY=${signing.DESKFLEET_IOS_SIGNING_IDENTITY}`))
  assert.ok(archive.includes(`DESKFLEET_IOS_APP_PROFILE_UUID=${signing.DESKFLEET_IOS_APP_PROFILE_UUID}`))
  assert.ok(archive.includes(`DESKFLEET_IOS_BROADCAST_PROFILE_UUID=${signing.DESKFLEET_IOS_BROADCAST_PROFILE_UUID}`))
  assert.equal(archive[archive.indexOf("-resultBundlePath") + 1], join(app, "diagnostics/archive.xcresult"))
  assert.ok(calls.flat().every(arg => !/^(?:-allowProvisioning|-authentication|PROVISIONING_PROFILE|CODE_SIGN_IDENTITY=)/u.test(arg)))
  assert.match(options, /<key>signingStyle<\/key><string>manual<\/string>/u)
  assert.ok(options.includes(`<key>signingCertificate</key><string>${signing.DESKFLEET_IOS_SIGNING_IDENTITY}</string>`))
  assert.ok(options.includes(`<key>ai.yetanother.deskfleet</key><string>${signing.DESKFLEET_IOS_APP_PROFILE_UUID}</string>`))
  assert.ok(options.includes(`<key>ai.yetanother.deskfleet.BroadcastUpload</key><string>${signing.DESKFLEET_IOS_BROADCAST_PROFILE_UUID}</string>`))
  assert.match(options, /<key>manageAppVersionAndBuildNumber<\/key><false\/>/u)
  assert.deepEqual(JSON.parse(readFileSync(join(app, "output/release.json"), "utf8")), {
    bundleId: "ai.yetanother.deskfleet", version: "0.16.0", buildNumber: "1234.2", ipa: "App.ipa",
  })
  assert.equal(existsSync(join(app, "App.xcarchive")), false)
  assert.equal(existsSync(join(app, "ExportOptions.plist")), false)
  for (const path of ["archive.log", "export.log", "archive.xcresult"]) assert.ok(existsSync(join(app, "diagnostics", path)))
})

test("unsigned smoke archives need no signing settings and do not produce release metadata", async context => {
  const { root, app, env } = fixture(context)
  const calls: string[][] = []
  await packageIosRelease(root, false, env, async (_command, args) => {
    calls.push(args)
    mkdirSync(join(app, "App.xcarchive"))
  })
  assert.equal(calls.length, 1)
  assert.ok(calls[0]!.includes("CODE_SIGNING_ALLOWED=NO"))
  assert.ok(calls[0]!.every(arg => !arg.startsWith("DESKFLEET_IOS_") && !arg.startsWith("DEVELOPMENT_TEAM=")))
  assert.ok(existsSync(join(app, "App.xcarchive")))
  assert.equal(existsSync(join(app, "output/release.json")), false)
})

test("signed packaging rejects missing prepared settings before invoking Xcode", async context => {
  const { root, env } = fixture(context)
  for (const name of Object.keys(signing)) {
    await assert.rejects(packageIosRelease(root, true, { ...env, ...signing, [name]: "" }, async () => {
      assert.fail("must reject before invoking Xcode")
    }), new RegExp(name))
  }
})

test("archive and export failures retain diagnostics and the archive without publishing metadata", async context => {
  for (const failAt of ["archive", "export", "missing-ipa"]) {
    const { root, app, env } = fixture(context)
    await assert.rejects(packageIosRelease(root, true, { ...env, ...signing }, async (_command, args, _cwd, logPath) => {
      writeFileSync(logPath, `${failAt} fixture\n`)
      if (!args.includes("-exportArchive")) {
        mkdirSync(join(app, "App.xcarchive"))
        mkdirSync(join(app, "diagnostics/archive.xcresult"))
        if (failAt === "archive") throw new Error("archive fixture failure")
      } else if (failAt === "export") {
        throw new Error("export fixture failure")
      }
    }), failAt === "missing-ipa" ? /did not produce App.ipa/ : /fixture failure/)
    assert.ok(existsSync(join(app, "App.xcarchive")))
    assert.ok(existsSync(join(app, "diagnostics/archive.log")))
    assert.ok(existsSync(join(app, "diagnostics/archive.xcresult")))
    if (failAt !== "archive") assert.ok(existsSync(join(app, "diagnostics/export.log")))
    assert.equal(existsSync(join(app, "ExportOptions.plist")), false)
    assert.equal(existsSync(join(app, "output/release.json")), false)
  }
})

test("failed commands retain both output streams and report the diagnostic log path", async context => {
  const { root } = fixture(context)
  const log = join(root, "command.log")
  await assert.rejects(runLoggedCommand(process.execPath, ["-e", 'console.log("archive stdout fixture"); console.error("archive stderr fixture"); process.exitCode = 65'], root, log), error => {
    assert.ok(error instanceof Error)
    assert.ok(error.message.includes("65"))
    assert.ok(error.message.includes(log))
    return true
  })
  const output = readFileSync(log, "utf8")
  assert.match(output, /archive stdout fixture/u)
  assert.match(output, /archive stderr fixture/u)
})

test("only application Release targets bind manual profiles; Debug remains automatic", () => {
  const project = readFileSync(join(import.meta.dirname, "../apps/web/ios/App/App.xcodeproj/project.pbxproj"), "utf8")
  const config = (id: string, name: string): string => {
    const start = project.indexOf(`${id} /* ${name} */ = {`)
    assert.notEqual(start, -1)
    return project.slice(start).split("\n\t\t};", 1)[0]!
  }
  for (const [id, profile] of [
    ["504EC3181FED79650016851F", "DESKFLEET_IOS_APP_PROFILE_UUID"],
    ["DF47701B2F00000100477001", "DESKFLEET_IOS_BROADCAST_PROFILE_UUID"],
  ]) {
    const release = config(id!, "Release")
    assert.match(release, /CODE_SIGN_STYLE = Manual;/u)
    assert.ok(release.includes('CODE_SIGN_IDENTITY = "$(DESKFLEET_IOS_SIGNING_IDENTITY)";'))
    assert.ok(release.includes(`PROVISIONING_PROFILE_SPECIFIER = "$(${profile})";`))
  }
  for (const id of ["504EC3171FED79650016851F", "DF47701A2F00000100477001"]) {
    const debug = config(id, "Debug")
    assert.match(debug, /CODE_SIGN_STYLE = Automatic;/u)
    assert.doesNotMatch(debug, /PROVISIONING_PROFILE_SPECIFIER|DESKFLEET_IOS_SIGNING_IDENTITY/u)
  }
  assert.equal(project.match(/PROVISIONING_PROFILE_SPECIFIER/gu)?.length, 2)
})
