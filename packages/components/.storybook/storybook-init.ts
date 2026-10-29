import { configureClient } from "@deskfleet/client/platform"

configureClient({
  platform: "darwin",
  locale: "en-US",
  target: { id: "machine-1", local: true },
})
