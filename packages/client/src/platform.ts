import type { DeskfleetDesktopApi } from "./desktop-api.ts"

let configured: DeskfleetDesktopApi | undefined

/** Hosts install their transport before mounting the shared application. */
export function configureClient(api: DeskfleetDesktopApi): void { configured = api }
export function getClient(): DeskfleetDesktopApi {
  if (!configured) throw new Error("The deskfleet platform adapter has not been configured")
  return configured
}

/** Resolves lazily so modules can share one host adapter without browser globals. */
export const client = new Proxy({} as DeskfleetDesktopApi, {
  get: (_target, key) => Reflect.get(getClient(), key),
  set: (_target, key, value) => Reflect.set(getClient(), key, value),
})
