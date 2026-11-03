import assert from "node:assert/strict"
import test from "node:test"
import { MAX_GENERATED_TITLE_LENGTH, truncateGeneratedTitle } from "./titles.ts"

test("short titles are unchanged after trim", () => {
  assert.equal(truncateGeneratedTitle("Fix flaky tests"), "Fix flaky tests")
  assert.equal(truncateGeneratedTitle("  keep me  "), "keep me")
})

test("long titles are truncated to the generated-title max", () => {
  const long = "Please investigate why the payment webhook retries forever and dumps a huge stack"
  assert.equal(truncateGeneratedTitle(long), long.slice(0, MAX_GENERATED_TITLE_LENGTH))
  assert.equal(truncateGeneratedTitle(long).length, MAX_GENERATED_TITLE_LENGTH)
})

test("empty and whitespace-only input becomes empty", () => {
  assert.equal(truncateGeneratedTitle(""), "")
  assert.equal(truncateGeneratedTitle(" \t\n "), "")
})

test("multi-byte characters truncate by UTF-16 code units like nearby string handling", () => {
  const text = "日本語のタイトルを十分に長くして切り詰めを確認する文章です"
  const truncated = truncateGeneratedTitle(text)
  assert.equal(truncated, text.slice(0, MAX_GENERATED_TITLE_LENGTH))
  assert.ok(truncated.length <= MAX_GENERATED_TITLE_LENGTH)
})

test("exact max length is preserved", () => {
  const exact = "x".repeat(MAX_GENERATED_TITLE_LENGTH)
  assert.equal(truncateGeneratedTitle(exact), exact)
  assert.equal(truncateGeneratedTitle(`${exact}y`), exact)
})
