import { HttpError, type HttpCentralClient } from "./http-central.ts"
import { authenticatePasskey, registerPasskey } from "./passkeys.ts"

type Transport = Pick<HttpCentralClient, "request">
export interface AuthConfig { webUrl: string; registrationEnabled: boolean }
export interface LoginSession { id: string; deviceId: string; createdAt: string; expiresAt: string; current: boolean }
export interface Passkey { id: string; name: string; createdAt: number }

/** The server asks for a fresh password or Passkey proof before credential changes. */
export const recentAuthenticationRequired = (reason: unknown) => reason instanceof HttpError && reason.code === "recent_authentication_required"

/** Owned-account endpoints behind the Web authentication and account security pages. */
export function accountAuthentication(api: Transport) {
  const post = <T = void>(path: string, body: unknown = {}) => api.request<T>("POST", `/api/auth/${path}`, body)
  const passkey = (id: string) => `/api/auth/passkeys/${encodeURIComponent(id)}`
  return {
    config: () => api.request<AuthConfig>("GET", "/api/auth/config"),
    login: (email: string, password: string) => post("login", { email, password }),
    loginWithPasskey: (email: string) => authenticatePasskey(api, "login", email),
    /** Sending again is the resend action; known addresses receive the same response. */
    register: (email: string) => post("register", { email }),
    verify: (token: string, name: string, password: string) => post("verify", { token, name, password }),
    requestRecovery: (email: string) => post("recovery", { email }),
    completeRecovery: (token: string, password: string) => post("recovery/complete", { token, password }),
    /** Omitting the password uses a Passkey assertion instead. */
    reauthenticate: (password?: string) => password === undefined ? authenticatePasskey(api, "reauthenticate") : post("reauthenticate", { password }),
    completeDesktop: (attempt: string) => post<{ returnTo: string }>("desktop/complete", { attempt }),
    changePassword: (password: string) => post("password", { password }),
    changeEmail: (email: string) => post("email", { email }),
    confirmEmail: (token: string) => post("email/verify", { token }),
    sessions: () => api.request<LoginSession[]>("GET", "/api/auth/sessions"),
    revokeSession: (id: string) => api.request<void>("DELETE", `/api/auth/sessions/${encodeURIComponent(id)}`),
    revokeAllSessions: () => post("sessions/revoke-all"),
    passkeys: () => api.request<Passkey[]>("GET", "/api/auth/passkeys"),
    addPasskey: (name: string) => registerPasskey(api, name),
    renamePasskey: (id: string, name: string) => api.request<void>("PATCH", passkey(id), { name }),
    removePasskey: (id: string) => api.request<void>("DELETE", passkey(id)),
  }
}
export type AccountAuthentication = ReturnType<typeof accountAuthentication>
