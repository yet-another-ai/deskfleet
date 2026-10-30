import { expect, test } from "vitest"
import { parseSentryDsn } from "./sentry-config.ts"

test("Sentry accepts public hosted and self-hosted DSNs", () => {
  expect(parseSentryDsn("  https://public_key@o123.ingest.sentry.io/456  ")).toEqual({
    dsn: "https://public_key@o123.ingest.sentry.io/456",
    origin: "https://o123.ingest.sentry.io",
  })
  expect(parseSentryDsn("http://publickey@sentry.example.com:9000/prefix/42")?.origin)
    .toBe("http://sentry.example.com:9000")
})

test.each([
  ["HTTPS://public@SENTRY.example.com:443/42", "https://public@sentry.example.com/42", "https://sentry.example.com"],
  ["https://public@例子.example/42", "https://public@xn--fsqu00a.example/42", "https://xn--fsqu00a.example"],
  ["http://public@127.0.0.1:9000/prefix/42", "http://public@127.0.0.1:9000/prefix/42", "http://127.0.0.1:9000"],
  ["http://public@[0:0:0:0:0:0:0:1]:9000/prefix/42", "http://public@[::1]:9000/prefix/42", "http://[::1]:9000"],
])("normalizes the SDK DSN and CSP origin together: %s", (value, dsn, origin) => {
  expect(parseSentryDsn(value)).toEqual({ dsn, origin })
})

test.each([
  undefined, "", "  ", "not-a-url", "https://sentry.example.com/1",
  "https://public:secret@sentry.example.com/1", "https://public@sentry.example.com/",
  "https://public@sentry.example.com/project", "ftp://public@sentry.example.com/1",
  "https://public@*.example.com/1", "https://public@sentry.example.com/1?secret=token",
  "https://public@sentry!.example.com/1", "https://public@sentry~.example.com/1",
  "https://public@sentry.example.com/1#fragment",
])("invalid or blank Sentry DSN disables reporting: %s", value => {
  expect(parseSentryDsn(value)).toBeUndefined()
})
