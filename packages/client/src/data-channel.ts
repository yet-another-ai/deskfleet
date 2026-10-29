/** The ordered message-channel surface shared by WebRTC and the local IPC adapter. */
export interface DataChannel extends EventTarget {
  readonly readyState: RTCDataChannelState
  binaryType: BinaryType
  readonly bufferedAmount: number
  bufferedAmountLowThreshold: number
  onopen: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  onclose: ((event: Event) => void) | null
  onerror: { handle(event: Event): void }["handle"] | null
  send(data: string | ArrayBuffer | ArrayBufferView): void
  close(): void
}

export class DataChannelErrorEvent extends Event {
  readonly error: Error
  constructor(error: Error) { super("error"); this.error = error }
}
