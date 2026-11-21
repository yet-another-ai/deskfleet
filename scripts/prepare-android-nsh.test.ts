import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { androidNshJavaSource } from "./prepare-android-nsh.ts"

test("Android bindings come from the resolved Cargo package, independent of the registry path", context => {
  const directory = mkdtempSync(join(tmpdir(), "deskfleet-nsh-source-"))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const source = join(directory, "java")
  mkdirSync(join(source, "com/longbridge/nsh"), { recursive: true })
  writeFileSync(join(source, "com/longbridge/nsh/NshView.java"), "package com.longbridge.nsh;")
  const dependency = { name: "nsh-platform-android", version: "0.6.0", manifest_path: join(directory, "Cargo.toml") }
  assert.equal(androidNshJavaSource({ packages: [
    { name: "nsh-core", version: "0.6.0", manifest_path: "/other/Cargo.toml" }, dependency,
  ] }), source)
  assert.throws(() => androidNshJavaSource({ packages: [dependency, { ...dependency, version: "0.6.1" }] }), /one locked/)
})

test("missing dependency or Java sources stop packaging instead of producing a mismatched JNI host", () => {
  assert.throws(() => androidNshJavaSource({ packages: [] }), /one locked/)
  assert.throws(() => androidNshJavaSource({ packages: [
    { name: "nsh-platform-android", version: "0.6.0", manifest_path: "/nonexistent/nsh/Cargo.toml" },
  ] }), /does not contain/)
})
