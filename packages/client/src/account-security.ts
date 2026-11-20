import type { AccountDeletionRequest } from "./account-deletion.ts"
import type { TelemetryConsentUpdate } from "./central.ts"
import { HttpError, type HttpCentralClient } from "./http-central.ts"
import { authenticatePasskey, registerPasskey } from "./passkeys.ts"

type Transport = Pick<HttpCentralClient, "request">
export interface AuthenticationMethods { password: boolean; passkey: boolean }
export interface PublicAuthenticationPolicy { registrationEnabled: boolean; captchaEnabled: boolean }
export interface AuthConfig extends PublicAuthenticationPolicy { webUrl: string; githubEnabled: boolean; googleEnabled: boolean; termsOfServiceUrl: string; privacyTermsUrl: string; telemetryEnabled?: boolean }
export type CaptchaAction = "login" | "register" | "passkey" | "github" | "google"
export interface LoginSession { id: string; deviceId: string; createdAt: string; expiresAt: string; current: boolean }
export interface Passkey { id: string; name: string; createdAt: number }

/** The server asks for a fresh identity proof before credential changes. */
export const recentAuthenticationRequired = (reason: unknown) => reason instanceof HttpError && reason.code === "recent_authentication_required"

/** Owned-account endpoints behind the Web authentication and account security pages. */
export function accountAuthentication(api: Transport) {
  const post = <T = void>(path: string, body: unknown = {}) => api.request<T>("POST", `/api/auth/${path}`, body)
  const passkey = (id: string) => `/api/auth/passkeys/${encodeURIComponent(id)}`
  return {
    sendEmailCode: () => post<{ challengeId: string; expiresIn: number; retryAfter: number }>("reauthenticate/email"),
    verifyEmailCode: (challengeId: string, code: string) => post("reauthenticate/email/verify", { challengeId, code }),
    authenticationMethods: () => api.request<AuthenticationMethods>("GET", "/api/auth/reauthenticate/methods"),
    config: () => api.request<AuthConfig>("GET", "/api/auth/config"),
    captchaChallenge: (action: CaptchaAction) => post<unknown>("captcha/challenge", { action }),
    login: (email: string, password: string, altcha?: string) => post("login", { email, password, ...(altcha ? { altcha } : {}) }),
    loginWithPasskey: (email: string, altcha?: string) => authenticatePasskey(api, "login", email, altcha),
    startGithub: (returnTo: string, acceptedTerms: boolean, altcha?: string) => post<{ authorizationUrl: string }>("github/start", { returnTo, acceptedTerms, ...(altcha ? { altcha } : {}) }),
    startGoogle: (returnTo: string, acceptedTerms: boolean, altcha?: string) => post<{ authorizationUrl: string }>("google/start", { returnTo, acceptedTerms, ...(altcha ? { altcha } : {}) }),
    /** Sending again is the resend action; known addresses receive the same response. */
    register: (email: string, acceptedTerms: boolean, altcha?: string) => post("register", { email, acceptedTerms, ...(altcha ? { altcha } : {}) }),
    verify: (token: string, name: string, password: string) => post("verify", { token, name, password }),
    requestRecovery: (email: string) => post("recovery", { email }),
    completeRecovery: (token: string, password: string) => post("recovery/complete", { token, password }),
    /** Omitting the password uses a Passkey assertion instead. */
    reauthenticate: (password?: string) => password === undefined ? authenticatePasskey(api, "reauthenticate") : post("reauthenticate", { password }),
    completeDesktop: (attempt: string, telemetryConsent?: TelemetryConsentUpdate) => post<{ returnTo: string }>("desktop/complete", { attempt, ...(telemetryConsent ? { telemetryConsent } : {}) }),
    updateTelemetryConsent: (update: TelemetryConsentUpdate) => api.request<void>("PUT", "/api/me/telemetry-consent", update),
    changePassword: (password: string) => post("password", { password }),
    changeEmail: (email: string) => post("email", { email }),
    confirmEmail: (token: string) => post("email/verify", { token }),
    sessions: () => api.request<LoginSession[]>("GET", "/api/auth/sessions"),
    revokeSession: (id: string) => api.request<void>("DELETE", `/api/auth/sessions/${encodeURIComponent(id)}`),
    revokeAllSessions: () => post("sessions/revoke-all"),
    deletionRequest: () => api.request<{ request: AccountDeletionRequest | null }>("GET", "/api/auth/account-deletion"),
    requestDeletion: (reason: string) => post<AccountDeletionRequest>("account-deletion", { reason }),
    cancelDeletion: () => api.request<void>("DELETE", "/api/auth/account-deletion"),
    passkeys: () => api.request<Passkey[]>("GET", "/api/auth/passkeys"),
    addPasskey: (name: string) => registerPasskey(api, name),
    renamePasskey: (id: string, name: string) => api.request<void>("PATCH", passkey(id), { name }),
    removePasskey: (id: string) => api.request<void>("DELETE", passkey(id)),
  }
}
export type AccountAuthentication = ReturnType<typeof accountAuthentication>
