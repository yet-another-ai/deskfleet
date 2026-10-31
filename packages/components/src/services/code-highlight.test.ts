import { expect, test } from "vitest"
import { canHighlight, fileCodeLanguage } from "./code-highlight.ts"

test.each([
  ["main.ts", "typescript"], ["types.d.ts", "typescript"], ["config.mts", "typescript"], ["config.cts", "typescript"],
  ["Component.tsx", "tsx"], ["app.js", "javascript"], ["config.mjs", "javascript"], ["config.cjs", "javascript"],
  ["Component.jsx", "jsx"], ["App.vue", "vue"], ["main.rs", "rust"], ["main.py", "python"],
  ["main.c", "c"], ["main.cpp", "cpp"], ["main.cs", "csharp"], ["main.go", "go"],
  ["package.json", "json"], ["settings.jsonc", "jsonc"], ["Cargo.toml", "toml"], ["pnpm-lock.yaml", "yaml"],
  ["pipeline.yml", "yaml"], ["README.MD", "markdown"], ["style.scss", "scss"], ["logo.svg", "xml"],
  ["setup.ps1", "powershell"], ["module.psm1", "powershell"], ["module.psd1", "powershell"],
  ["schema.graphql", "graphql"], ["service.proto", "proto"], ["change.patch", "diff"],
])("recognizes %s using an already loaded grammar", (filename, language) => {
  expect(fileCodeLanguage(filename)).toBe(language)
  expect(canHighlight(language)).toBe(true)
})

test.each([
  ["Dockerfile", "dockerfile"], ["Dockerfile.dev", "dockerfile"], ["app.dockerfile", "dockerfile"],
  ["Containerfile", "dockerfile"], ["Makefile", "makefile"], ["GNUmakefile", "makefile"],
  ["Gemfile", "ruby"], ["Rakefile", "ruby"], ["Cargo.lock", "toml"],
  [".bashrc", "bash"], [".zshrc", "bash"], [".env", "bash"], [".env.local", "bash"],
  [".gitconfig", "ini"], [".npmrc", "ini"], [".editorconfig", "ini"],
])("recognizes the conventional file name %s", (filename, language) => {
  expect(fileCodeLanguage(filename)).toBe(language)
  expect(canHighlight(language)).toBe(true)
})

test.each(["notes.txt", "README", "unknown.custom", "build.log", "file.json.backup", "", "main.ts#L2", "main.ts:2"])(
  "keeps unrecognized file name %s as plain text",
  filename => expect(fileCodeLanguage(filename)).toBeUndefined(),
)
