import { FILE_CHUNK_BYTES, FILE_PIPELINE_CHUNKS, type FileEndpoint, type FileEntry, type FileReply } from "../../../apps/daemon/src/files-protocol.ts"

export { FILE_PIPELINE_CHUNKS } from "../../../apps/daemon/src/files-protocol.ts"

export async function copyFileChunks(options: {
  source: FileEndpoint; destination: FileEndpoint; file: FileEntry; transferId: string; path: string
  check(): void; progress(bytes: number): void
}): Promise<void> {
  const { source, destination, file, transferId, path } = options
  const active = new Set<Promise<void>>()
  let available: (() => void) | undefined
  let submitting = Promise.resolve()
  let failure: { error: unknown } | undefined
  const fail = (error: unknown) => { failure ??= { error } }
  const check = () => { options.check(); if (failure) throw failure.error }

  function queue(offset: number, length: number): void {
    // Observe read failures immediately, including reads ahead of a slower chunk.
    const reading = (length
      ? source.call("read", { path: file.path, offset, length, modifiedAt: file.modifiedAt })
      : Promise.resolve({ value: { bytes: 0 }, data: new Uint8Array() })
    ).catch(error => { fail(error); return undefined })
    let writing: Promise<FileReply<{ bytes: number }>> | undefined
    const submitted = submitting.then(async () => {
      const chunk = await reading
      check()
      if (!chunk?.data || chunk.data.byteLength !== length || chunk.value.bytes !== length) throw new Error(`File changed during transfer: ${file.name}`)
      // Submit writes in offset order, but let the next chunk enter the channel
      // before this acknowledgement returns. Receivers serialize disk mutations.
      writing = destination.call("write", { transferId, path, offset }, chunk.data)
      void writing.catch(fail)
    })
    submitting = submitted.catch(fail)
    const completed = submitted.then(async () => {
      const written = await writing!
      if (written.value.bytes !== length) throw new Error("Receiver did not confirm the complete chunk")
      check(); options.progress(length)
    }).catch(fail).finally(() => {
      active.delete(completed)
      available?.(); available = undefined
    })
    active.add(completed)
  }

  try {
    // An empty file still needs its zero-byte write before finish.
    let offset = 0
    do {
      check()
      const length = Math.min(FILE_CHUNK_BYTES, file.size - offset)
      queue(offset, length)
      offset += length
      // A single capacity waiter avoids attaching a new handler to every
      // outstanding chunk each time one of the 512 slots becomes available.
      if (active.size >= FILE_PIPELINE_CHUNKS) await new Promise<void>(resolve => { available = resolve })
    } while (offset < file.size)
    await Promise.all(active)
    check()
  } finally {
    // No finish/commit/next item may race requests from this file, even on error.
    await Promise.all(active)
  }
}
