import type { GoogleTagMessage } from "@deskfleet/client/google-tag"

export const GOOGLE_TAG_CHANNEL = "deskfleet:google-tag"

export interface GoogleTagBridge {
  send(message: GoogleTagMessage): Promise<void>
}
