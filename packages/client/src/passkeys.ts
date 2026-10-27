import type { HttpCentralClient } from "./http-central.ts"

type Transport = Pick<HttpCentralClient, "request">
export const passkeysAvailable = () => typeof PublicKeyCredential !== "undefined"
  && typeof PublicKeyCredential.parseCreationOptionsFromJSON === "function"

/** The browser performs user verification; only the signed assertion reaches the server. */
export async function authenticatePasskey(api: Transport, purpose: "login" | "reauthenticate", email?: string): Promise<void> {
  const options = await api.request<{ ceremonyId: string; publicKey: PublicKeyCredentialRequestOptionsJSON }>("POST", `/api/auth/passkeys/${purpose}/options`, email ? { email } : {})
  const credential = await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options.publicKey) })
  if (!(credential instanceof PublicKeyCredential)) throw new Error("Passkey authentication was cancelled")
  await api.request("POST", `/api/auth/passkeys/${purpose}`, { ceremonyId: options.ceremonyId, credential: credential.toJSON() })
}
export async function registerPasskey(api: Transport, name: string): Promise<void> {
  const options = await api.request<{ ceremonyId: string; publicKey: PublicKeyCredentialCreationOptionsJSON }>("POST", "/api/auth/passkeys/register/options", {})
  const credential = await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options.publicKey) })
  if (!(credential instanceof PublicKeyCredential)) throw new Error("Passkey registration was cancelled")
  await api.request("POST", "/api/auth/passkeys/register", { ceremonyId: options.ceremonyId, credential: credential.toJSON(), name })
}
