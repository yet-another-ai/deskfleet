/** Capability profile, independent of the provisional control protocol version. */
export const MUX_PROFILE = "fixed4-v1"
export const MUX_LABELS = {
  control: "deskfleet-mux-control",
  terminal: "deskfleet-mux-terminal",
  agent: "deskfleet-mux-agent",
  bulk: "deskfleet-mux-bulk",
} as const
export type MuxLane = keyof typeof MUX_LABELS
export type MuxDataLane = Exclude<MuxLane, "control">
export type MuxPurpose = "agent" | "terminal" | "files"
export const MUX_FRAME_BYTES = 16 * 1024
export const MUX_MESSAGE_BYTES = 64 * 1024
export const MUX_HEADER_BYTES = 17
export const MUX_WINDOW_BYTES = 128 * 1024
export const MUX_STREAM_QUEUE_BYTES = 1024 * 1024
export const MUX_CONNECTION_QUEUE_BYTES = 8 * 1024 * 1024
export const MUX_MAX_STREAMS = 128

export type MuxControl =
  | { type: "open"; id: number; purpose: MuxPurpose }
  | { type: "opened"; id: number }
  | { type: "credit"; id: number; bytes: number }
  | { type: "close"; id: number; error?: string }

export interface MuxFrame { id: number; sequence: number; offset: number; total: number; text: boolean; data: Uint8Array }
const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })
export const muxDefaultLane = (purpose: MuxPurpose): MuxDataLane => purpose === "files" ? "bulk" : purpose
export const muxPurpose = (value: unknown): value is MuxPurpose => value === "agent" || value === "terminal" || value === "files"
export const muxFrameCost = (bytes: number): number => Math.max(1024, bytes)
export const muxLaneAllowed = (purpose: MuxPurpose, lane: MuxDataLane): boolean => lane === "bulk" || lane === purpose
export const muxLane = (label: string): MuxLane | undefined => (Object.keys(MUX_LABELS) as MuxLane[]).find(lane => MUX_LABELS[lane] === label)

export function encodeMuxControl(value: MuxControl): Uint8Array { return encoder.encode(JSON.stringify(value)) }
export function decodeMuxControl(bytes: Uint8Array): MuxControl {
  if (bytes.length > 1024) throw new Error("Mux control frame is too large")
  const value: unknown = JSON.parse(decoder.decode(bytes))
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Mux control frame")
  const record = value as Record<string, unknown>
  if (!Number.isInteger(record.id) || (record.id as number) <= 0 || (record.id as number) > 0xffffffff) throw new Error("Invalid Mux stream ID")
  if (record.type === "open" && muxPurpose(record.purpose)) return record as MuxControl
  if (record.type === "opened") return record as MuxControl
  if (record.type === "close" && (record.error === undefined || typeof record.error === "string" && record.error.length <= 256)) return record as MuxControl
  if (record.type === "credit" && Number.isInteger(record.bytes) && (record.bytes as number) > 0 && (record.bytes as number) <= MUX_WINDOW_BYTES) return record as MuxControl
  throw new Error("Invalid Mux control frame")
}

export function encodeMuxFrame(frame: MuxFrame): Uint8Array {
  const bytes = new Uint8Array(MUX_HEADER_BYTES + frame.data.length)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, frame.id); view.setUint32(4, frame.sequence)
  view.setUint32(8, frame.offset); view.setUint32(12, frame.total)
  view.setUint8(16, frame.text ? 1 : 0)
  bytes.set(frame.data, MUX_HEADER_BYTES)
  return bytes
}

export function decodeMuxFrame(bytes: Uint8Array): MuxFrame {
  if (bytes.length < MUX_HEADER_BYTES || bytes.length > MUX_FRAME_BYTES) throw new Error("Invalid Mux frame size")
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const frame = { id: view.getUint32(0), sequence: view.getUint32(4), offset: view.getUint32(8), total: view.getUint32(12), text: view.getUint8(16) === 1, data: bytes.subarray(MUX_HEADER_BYTES) }
  if (!frame.id || frame.total > MUX_MESSAGE_BYTES || frame.offset + frame.data.length > frame.total || view.getUint8(16) > 1 || frame.data.length === 0 && (frame.total !== 0 || frame.offset !== 0)) throw new Error("Invalid Mux data frame")
  return frame
}
