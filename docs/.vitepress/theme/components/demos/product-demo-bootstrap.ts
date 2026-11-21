import { DEFAULT_LOCALE } from "@deskfleet/client/i18n"
import { configureProductDemoHost } from "./product-demo-host.ts"
import type { ProductDemoOptions } from "./product-demo-runtime.ts"

/** Mount the production application with browser-local state and no daemon connection. */
export async function mountProductDemo(target: HTMLElement, options: ProductDemoOptions) {
  const locale = options.locale ?? DEFAULT_LOCALE
  // Shared modules read the platform adapter as soon as they are evaluated.
  configureProductDemoHost(locale)
  const { mountProductDemoApp } = await import("./product-demo-runtime.ts")
  return mountProductDemoApp(target, { ...options, locale })
}
