export const STATSIG_INITIALIZE_URL = "https://featureassets.org/v1/initialize"
export const STATSIG_LOG_EVENT_URL = "https://prodregistryv2.org/v1/rgstr"
export const STATSIG_SDK_EXCEPTION_URL = "https://statsigapi.net/v1/sdk_exception"

export const STATSIG_CONNECT_ORIGINS = [
  new URL(STATSIG_INITIALIZE_URL).origin,
  new URL(STATSIG_LOG_EVENT_URL).origin,
  new URL(STATSIG_SDK_EXCEPTION_URL).origin,
] as const
