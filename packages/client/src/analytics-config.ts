export const STATSIG_INITIALIZE_URL = "https://featureassets.org/v1/initialize"
export const STATSIG_LOG_EVENT_URL = "https://prodregistryv2.org/v1/rgstr"
export const STATSIG_SDK_EXCEPTION_URL = "https://statsigapi.net/v1/sdk_exception"

export const STATSIG_CONNECT_ORIGINS = [
  new URL(STATSIG_INITIALIZE_URL).origin,
  new URL(STATSIG_LOG_EVENT_URL).origin,
  new URL(STATSIG_SDK_EXCEPTION_URL).origin,
] as const

export const GOOGLE_TAG_SCRIPT_ORIGINS = [
  "https://www.googletagmanager.com",
] as const

export const GOOGLE_TAG_CONNECT_ORIGINS = [
  "https://www.googletagmanager.com",
  "https://www.google-analytics.com",
  "https://analytics.google.com",
  "https://region1.google-analytics.com",
  "https://www.googleadservices.com",
  "https://googleads.g.doubleclick.net",
] as const

export const GOOGLE_TAG_IMG_ORIGINS = [
  "https://www.googletagmanager.com",
  "https://www.google-analytics.com",
  "https://www.googleadservices.com",
  "https://googleads.g.doubleclick.net",
] as const
