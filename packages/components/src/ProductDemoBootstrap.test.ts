import { expect, test, vi } from "vitest"

vi.mock("vitepress", () => ({ withBase: (path: string) => path }))

test("the first website demo mounts with no platform adapter configured at startup", async () => {
  // The renderer test setup installs a platform. Reload modules to simulate a fresh page.
  vi.resetModules()
  const { getClient } = await import("@deskfleet/client/platform")
  expect(getClient).toThrow("The DeskFleet platform adapter has not been configured")

  const { mountProductDemo } = await import("../../../docs/.vitepress/theme/components/demos/product-demo-bootstrap.ts")
  const target = document.createElement("div")
  const cleanup = await mountProductDemo(target, { kind: "agents", locale: "ja-JP", sidebar: true })
  try {
    expect(getClient().locale).toBe("ja-JP")
    expect(target.lang).toBe("ja-JP")
    expect(target.querySelector('[data-sidebar-tab="desktops"]')).toBeInstanceOf(HTMLButtonElement)
  } finally {
    cleanup()
  }
}, 120_000)
