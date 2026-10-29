import { createHighlighterCoreSync } from "shiki/core"
import { createJavaScriptRegexEngine } from "shiki/engine/javascript"
import bash from "shiki/langs/bash.mjs"
import cpp from "shiki/langs/cpp.mjs"
import csharp from "shiki/langs/csharp.mjs"
import css from "shiki/langs/css.mjs"
import diff from "shiki/langs/diff.mjs"
import dockerfile from "shiki/langs/dockerfile.mjs"
import go from "shiki/langs/go.mjs"
import graphql from "shiki/langs/graphql.mjs"
import html from "shiki/langs/html.mjs"
import ini from "shiki/langs/ini.mjs"
import java from "shiki/langs/java.mjs"
import javascript from "shiki/langs/javascript.mjs"
import json from "shiki/langs/json.mjs"
import jsonc from "shiki/langs/jsonc.mjs"
import jsx from "shiki/langs/jsx.mjs"
import kotlin from "shiki/langs/kotlin.mjs"
import lua from "shiki/langs/lua.mjs"
import makefile from "shiki/langs/makefile.mjs"
import markdown from "shiki/langs/markdown.mjs"
import php from "shiki/langs/php.mjs"
import powershell from "shiki/langs/powershell.mjs"
import proto from "shiki/langs/proto.mjs"
import python from "shiki/langs/python.mjs"
import ruby from "shiki/langs/ruby.mjs"
import rust from "shiki/langs/rust.mjs"
import scss from "shiki/langs/scss.mjs"
import sql from "shiki/langs/sql.mjs"
import swift from "shiki/langs/swift.mjs"
import toml from "shiki/langs/toml.mjs"
import tsx from "shiki/langs/tsx.mjs"
import typescript from "shiki/langs/typescript.mjs"
import vue from "shiki/langs/vue.mjs"
import xml from "shiki/langs/xml.mjs"
import yaml from "shiki/langs/yaml.mjs"
import zig from "shiki/langs/zig.mjs"
import githubDark from "shiki/themes/github-dark.mjs"
import githubLight from "shiki/themes/github-light.mjs"

const grammars = [
  bash, cpp, csharp, css, diff, dockerfile, go, graphql, html, ini, java, javascript, json, jsonc, jsx, kotlin, lua,
  makefile, markdown, php, powershell, proto, python, ruby, rust, scss, sql, swift, toml, tsx, typescript, vue, xml, yaml, zig,
]
const languageNames = new Map<string, string>()
for (const grammar of grammars.flat()) {
  if (!grammar.displayName) continue
  languageNames.set(grammar.name, grammar.displayName)
  for (const alias of grammar.aliases ?? []) languageNames.set(alias, grammar.displayName)
}

export const highlighter = createHighlighterCoreSync({
  themes: [githubLight, githubDark],
  langs: grammars,
  engine: createJavaScriptRegexEngine(),
  warnings: false,
})
const loadedLanguages = new Set(highlighter.getLoadedLanguages())

export function codeLanguageName(language: string): string | undefined {
  return language ? languageNames.get(language) : undefined
}

export function canHighlight(language: string): boolean {
  return loadedLanguages.has(language)
}
