interface MediaSmokeBridge {
  send(message: unknown): void
  onMessage(listener: (message: { kind: string; sdp?: string; candidate?: RTCIceCandidateInit }) => void): void
}

const bridge = (window as unknown as { mediaSmoke: MediaSmokeBridge }).mediaSmoke
const capture = document.documentElement.dataset.capture === "1"
const peer = new RTCPeerConnection({ iceServers: [] })
const video = document.querySelector("video")!
const stream = new MediaStream()
video.srcObject = stream
const pendingRemote: RTCIceCandidateInit[] = []
const pendingLocal: RTCIceCandidateInit[] = []
let offerSent = false
let echoReceived = false
let finished = false
let answerApplied = false

function fail(error: unknown): void {
  if (finished) return
  finished = true
  peer.close()
  bridge.send({ kind: "error", error: String(error) })
}

peer.onicecandidate = ({ candidate }) => {
  if (!candidate) return
  const value = candidate.toJSON()
  if (offerSent) bridge.send({ kind: "candidate", candidate: value })
  else pendingLocal.push(value)
}
peer.ontrack = ({ track }) => {
  stream.addTrack(track)
  void video.play().catch(fail)
}
peer.onconnectionstatechange = () => {
  if (peer.connectionState === "failed") {
    fail(`Chromium peer connection failed (ICE: ${peer.iceConnectionState})`)
  }
}
const channel = peer.createDataChannel("smoke")
channel.onopen = () => channel.send("chromium-native-echo")
channel.onmessage = ({ data }) => {
  if (data !== "chromium-native-echo") fail("DataChannel echo payload changed")
  else echoReceived = true
}

bridge.onMessage(message => {
  void (async () => {
    if (message.kind === "answer") {
      if (!message.sdp?.includes("H264/90000") || (!capture && !message.sdp.includes("opus/48000"))) {
        throw new Error(capture ? "native answer must negotiate H.264" : "native answer must negotiate H.264 and Opus")
      }
      await peer.setRemoteDescription({ type: "answer", sdp: message.sdp })
      answerApplied = true
      for (const candidate of pendingRemote.splice(0)) await peer.addIceCandidate(candidate)
    } else if (message.kind === "candidate" && message.candidate) {
      if (answerApplied) await peer.addIceCandidate(message.candidate)
      else pendingRemote.push(message.candidate)
    }
  })().catch(fail)
})

async function run(): Promise<void> {
  const receiverCodecs = RTCRtpReceiver.getCapabilities("video")?.codecs ?? []
  const h264 = receiverCodecs.filter(codec =>
    codec.mimeType.toLowerCase() === "video/h264" &&
    /(?:^|;)profile-level-id=42e0[0-9a-f]{2}(?:;|$)/i.test(codec.sdpFmtpLine ?? "") &&
    /(?:^|;)packetization-mode=1(?:;|$)/.test(codec.sdpFmtpLine ?? ""),
  )
  if (!h264.length) throw new Error("Chromium has no constrained baseline H.264 receiver")
  const transceiver = peer.addTransceiver("video", { direction: "recvonly" })
  transceiver.setCodecPreferences(h264)
  if (!capture) peer.addTransceiver("audio", { direction: "recvonly" })
  await peer.setLocalDescription(await peer.createOffer())
  bridge.send({ kind: "offer", sdp: peer.localDescription!.sdp })
  offerSent = true
  for (const candidate of pendingLocal.splice(0)) bridge.send({ kind: "candidate", candidate })

  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100))
    if (finished) return
    const reports = [...(await peer.getStats()).values()] as RTCInboundRtpStreamStats[]
    const receivedVideo = reports.find(report => report.type === "inbound-rtp" && report.kind === "video")
    const receivedAudio = reports.find(report => report.type === "inbound-rtp" && report.kind === "audio")
    if (
      !echoReceived || peer.connectionState !== "connected" || !receivedVideo ||
      (receivedVideo.framesDecoded ?? 0) < (capture ? 1 : 3) ||
      video.videoWidth <= 0 || video.videoHeight <= 0
    ) continue
    let pixel: number[] | undefined
    if (!capture) {
      if (!receivedAudio?.packetsReceived || video.videoWidth !== 64 || video.videoHeight !== 64) continue
      const canvas = document.createElement("canvas")
      canvas.width = 64
      canvas.height = 64
      const context = canvas.getContext("2d")!
      context.drawImage(video, 0, 0)
      pixel = Array.from(context.getImageData(32, 32, 1, 1).data)
      if (pixel[0]! < 200 || pixel[1]! > 40 || pixel[2]! > 40) {
        throw new Error(`decoded frame is not red: ${pixel}`)
      }
    }
    bridge.send({ kind: "complete", result: {
      source: capture ? "desktop" : "fixture",
      connection: peer.connectionState,
      framesDecoded: receivedVideo.framesDecoded,
      ...(capture ? {} : { audioPackets: receivedAudio?.packetsReceived, pixel }),
      width: video.videoWidth,
      height: video.videoHeight,
      dataChannel: echoReceived,
    } })
    finished = true
    peer.close()
    return
  }
  throw new Error(capture
    ? "Chromium did not decode a desktop frame before timeout"
    : "Chromium did not decode native H.264/Opus media before timeout")
}

void run().catch(fail)

export {}
