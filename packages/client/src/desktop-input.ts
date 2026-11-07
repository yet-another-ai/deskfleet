import type { DesktopErrorReason } from "./desktop-media.ts"

/** Desktop input travels over the desktop peer's reliable, ordered DataChannel. */
export const DESKTOP_INPUT_CHANNEL = "deskfleet-input"

/** Browser button numbering: primary, auxiliary, secondary, back, forward. */
export type DesktopPointerButton = 0 | 1 | 2 | 3 | 4

/** Coordinates are relative to the captured display, normalized to [0, 1]. */
export type DesktopInputMessage =
  | { type: "pointerMove"; x: number; y: number }
  | { type: "pointerButton"; button: DesktopPointerButton; pressed: boolean; x: number; y: number }
  /** Scroll deltas use CSS pixels; positive values scroll right/down. */
  | { type: "wheel"; deltaX: number; deltaY: number }
  /** Physical KeyboardEvent.code, interpreted using the target machine's layout. */
  | { type: "key"; code: string; pressed: boolean; repeat: boolean }
  /** Windows secure attention sequence, handled by the authorized desktop service. */
  | { type: "secureAttention" }
  | { type: "releaseAll" }

/** Live settings share the ordered channel so disabling control follows held-key releases. */
export interface DesktopSettingsMessage {
  type: "configure"
  requestId: number
  audio: boolean
  control: boolean
}

export type DesktopInputReply =
  | { type: "ready" }
  | { type: "error"; error: string }
  | { type: "configured"; requestId: number; control: boolean }
  | { type: "configurationError"; requestId: number; control: boolean; error: string; reason?: DesktopErrorReason }
