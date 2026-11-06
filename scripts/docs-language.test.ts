import assert from "node:assert/strict"
import test from "node:test"
import { firstVisitLanguageRedirect } from "../docs/.vitepress/theme/preferred-language.ts"

function browserAt(path = "/", values = new Map<string, string>()) {
  return {
    location: new URL(path, "https://www.deskfleet.org"),
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
    },
  }
}

test("first visits use the supported browser language order and retain query/hash", () => {
  for (const [languages, path] of [
    [["zh-CN", "en-US"], "/zh/"],
    [["ja-JP", "zh-CN"], "/ja/"],
    [["fr-FR", "ja"], "/ja/"],
  ] as const) {
    const browser = browserAt("/?utm_source=launch#get-deskfleet")
    assert.equal(firstVisitLanguageRedirect(browser, languages), `${path}?utm_source=launch#get-deskfleet`)
  }
})

test("the decision persists before navigation and prevents redirects after reload or manual switching", () => {
  const values = new Map<string, string>()
  assert.equal(firstVisitLanguageRedirect(browserAt("/", values), ["zh-CN"]), "/zh/")
  assert.equal(values.size, 1)
  assert.equal(firstVisitLanguageRedirect(browserAt("/zh/", values), ["zh-CN"]), undefined)
  assert.equal(firstVisitLanguageRedirect(browserAt("/", values), ["zh-CN"]), undefined)
  assert.equal(firstVisitLanguageRedirect(browserAt("/", values), ["ja-JP"]), undefined)
})

test("English and unsupported preferences also finish the first-visit check", () => {
  for (const languages of [["en-GB", "zh-CN"], ["fr-FR"], ["zh-TW"], []]) {
    const browser = browserAt()
    assert.equal(firstVisitLanguageRedirect(browser, languages), undefined)
    assert.equal(firstVisitLanguageRedirect(browser, ["ja-JP"]), undefined)
  }
})

test("explicit language pages and deep links remain selected on this and later visits", () => {
  for (const path of ["/zh/", "/ja/", "/guide/", "/zh/guide/getting-started", "/privacy", "/missing"]) {
    const values = new Map<string, string>()
    assert.equal(firstVisitLanguageRedirect(browserAt(path, values), ["ja-JP"]), undefined)
    assert.equal(firstVisitLanguageRedirect(browserAt("/", values), ["ja-JP"]), undefined)
  }
})

test("default homepage aliases receive the same first-visit behavior", () => {
  for (const path of ["/index", "/index.html"]) {
    assert.equal(firstVisitLanguageRedirect(browserAt(path), ["ja-JP"]), "/ja/")
  }
})

test("unavailable storage skips redirects rather than repeating them", () => {
  const fail = () => { throw new Error("Storage unavailable") }
  const browser = browserAt()
  for (const localStorage of [
    { getItem: fail, setItem: browser.localStorage.setItem },
    { getItem: browser.localStorage.getItem, setItem: fail },
  ]) {
    assert.equal(firstVisitLanguageRedirect({ ...browser, localStorage }, ["zh-CN"]), undefined)
  }
  assert.equal(firstVisitLanguageRedirect({ ...browser, get localStorage() { return fail() } }, ["zh-CN"]), undefined)
})
