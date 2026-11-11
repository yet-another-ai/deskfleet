import type { CapacitorConfig } from "@capacitor/cli"
import { env } from "node:process"

const serverURL = env.CAPACITOR_DEV_SERVER_URL
const isCleartext = serverURL?.startsWith("http://") ?? false
const releaseType = env.ANDROID_RELEASE_TYPE === "APK" ? "APK" : env.ANDROID_RELEASE_TYPE === "AAB" ? "AAB" : undefined
const signingType = env.ANDROID_SIGNING_TYPE === "apksigner"
  ? "apksigner"
  : env.ANDROID_SIGNING_TYPE === "jarsigner"
    ? "jarsigner"
    : releaseType === "APK"
      ? "apksigner"
      : undefined

const config: CapacitorConfig = {
  appId: "ai.yetanother.deskfleet",
  appName: "DeskFleet",
  webDir: "dist",
  server: serverURL
    ? {
        url: serverURL,
        cleartext: isCleartext,
      }
    : undefined,
  android: {
    buildOptions: {
      keystorePath: env.ANDROID_KEYSTORE_PATH,
      keystorePassword: env.ANDROID_KEYSTORE_PASSWORD,
      keystoreAlias: env.ANDROID_KEY_ALIAS,
      keystoreAliasPassword: env.ANDROID_KEY_PASSWORD,
      releaseType,
      signingType,
    },
  },
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
    SystemBars: {
      initialViewportFitValueHint: "cover",
    },
  },
  experimental: {
    ios: {
      spm: {
        swiftToolsVersion: "6.0",
      },
    },
  },
}

export default config
