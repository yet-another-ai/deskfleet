import type { CapacitorConfig } from "@capacitor/cli"
import { env } from "node:process"

const serverURL = env.CAPACITOR_DEV_SERVER_URL
const isCleartext = serverURL?.startsWith("http://") ?? false

const config: CapacitorConfig = {
  appId: "io.github.yet_another_ai.deskfleet.mobile",
  appName: "DeskFleet",
  webDir: "dist",
  server: serverURL
    ? {
        url: serverURL,
        cleartext: isCleartext,
      }
    : undefined,
  plugins: {
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
