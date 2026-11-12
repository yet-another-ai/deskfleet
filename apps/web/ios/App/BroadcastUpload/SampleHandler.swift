import Accelerate
import CoreAudioTypes
import CoreMedia
import Foundation
import ReplayKit

final class SampleHandler: RPBroadcastSampleHandler, @unchecked Sendable {
    private static let frameIntervalMs: UInt64 = 22

    private let lock = NSLock()
    private let analyzer = OutlineAudioSpectrumAnalyzer()
    private var store: OutlineAudioSharedStore?
    private var heartbeatTimer: DispatchSourceTimer?
    private var spectrum = [UInt8](repeating: 0, count: OutlineAudioSharedStore.stereoSpectrumBytes)
    private var lastFrameEmitMs: UInt64 = 0
    private var wasSilent = true
    private var finished = false

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        lock.lock()
        defer { lock.unlock() }
        finished = false
        wasSilent = true
        let sharedStore = store ?? OutlineAudioSharedStore()
        store = sharedStore
        sharedStore?.markBroadcastStarted()

        heartbeatTimer?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
        timer.schedule(deadline: .now() + .seconds(1), repeating: .seconds(1), leeway: .milliseconds(200))
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            self.lock.lock()
            defer { self.lock.unlock() }
            guard !self.finished, let sharedStore = self.store else { return }
            if sharedStore.isStopRequested { self.stopFromAppLocked() }
            else { sharedStore.updateHeartbeat() }
        }
        heartbeatTimer = timer
        timer.resume()
    }

    override func broadcastFinished() {
        lock.lock()
        defer { lock.unlock() }
        finished = true
        heartbeatTimer?.cancel()
        heartbeatTimer = nil
        store?.markBroadcastStopped()
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        lock.lock()
        defer { lock.unlock() }
        guard !finished, let sharedStore = store else { return }
        if sharedStore.isStopRequested {
            stopFromAppLocked()
            return
        }
        guard sampleBufferType == .audioApp, analyzer.appendSampleBuffer(sampleBuffer) else { return }

        let nowMs = OutlineAudioSharedStore.nowMs()
        if nowMs >= lastFrameEmitMs + Self.frameIntervalMs {
            lastFrameEmitMs = nowMs
            let hasSignal = analyzer.computeSpectrum(into: &spectrum)
            if hasSignal || !wasSilent {
                wasSilent = !hasSignal
                sharedStore.writeSpectrum(spectrum, sampleRate: analyzer.sampleRate, timestampMs: nowMs)
            }
        }
    }

    private func stopFromAppLocked() {
        guard !finished else { return }
        finished = true
        heartbeatTimer?.cancel()
        heartbeatTimer = nil
        store?.markBroadcastStopped()
        finishBroadcastWithError(NSError(
            domain: "ai.yetanother.deskfleet.BroadcastUpload",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "Audio-reactive outline was turned off in DeskFleet."]
        ))
    }

    deinit {
        heartbeatTimer?.cancel()
    }
}

/// Accelerate/vDSP 4096-point Blackman FFT quantizing [left(224), right(224)] dB bins in [-80, -10] dB.
private final class OutlineAudioSpectrumAnalyzer {
    private static let fftSize = 4096
    private static let log2Fft: vDSP_Length = 12
    private static let ringMask = fftSize - 1
    private static let smoothing: Float = 0.2
    private static let minLinear: Float = 1e-4 // -80 dB

    private let fftSetup = vDSP_create_fftsetup(log2Fft, FFTRadix(kFFTRadix2))
    private let window: [Float] = {
        var w = [Float](repeating: 0, count: fftSize)
        vDSP_blkman_window(&w, vDSP_Length(fftSize), 0)
        return w
    }()
    private var ringLeft = [Float](repeating: 0, count: fftSize)
    private var ringRight = [Float](repeating: 0, count: fftSize)
    private var ringCursor = 0
    private var splitReal = [Float](repeating: 0, count: fftSize)
    private var splitImag = [Float](repeating: 0, count: fftSize)
    private var smoothedLeft = [Float](repeating: 0, count: OutlineAudioSharedStore.spectrumBins)
    private var smoothedRight = [Float](repeating: 0, count: OutlineAudioSharedStore.spectrumBins)
    private(set) var sampleRate = 48_000

    deinit {
        if let setup = fftSetup { vDSP_destroy_fftsetup(setup) }
    }

    func appendSampleBuffer(_ sampleBuffer: CMSampleBuffer) -> Bool {
        guard let desc = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(desc)?.pointee,
              asbd.mFormatID == kAudioFormatLinearPCM else { return false }
        let totalFrames = CMSampleBufferGetNumSamples(sampleBuffer)
        guard totalFrames > 0 else { return false }
        if asbd.mSampleRate > 0 { sampleRate = Int(asbd.mSampleRate.rounded()) }

        let listBytes = MemoryLayout<AudioBufferList>.size + MemoryLayout<AudioBuffer>.stride * 2
        let rawList = UnsafeMutableRawPointer.allocate(byteCount: listBytes, alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { rawList.deallocate() }
        let listPtr = rawList.assumingMemoryBound(to: AudioBufferList.self)
        var blockBuffer: CMBlockBuffer?
        guard CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer, bufferListSizeNeededOut: nil, bufferListOut: listPtr, bufferListSize: listBytes,
            blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, blockBufferOut: &blockBuffer
        ) == noErr else { return false }

        let buffers = UnsafeMutableAudioBufferListPointer(listPtr)
        guard let firstData = buffers.first?.mData else { return false }
        let isFloat = (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0
        let isBig = (asbd.mFormatFlags & kAudioFormatFlagIsBigEndian) != 0
        let planar = (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0 || buffers.count >= 2
        let bits = Int(asbd.mBitsPerChannel)
        let sampleBytes = max(1, bits / 8)
        let channels = max(1, Int(asbd.mChannelsPerFrame))
        let stride = planar ? sampleBytes : sampleBytes * channels
        let frames = min(totalFrames, Int(buffers[0].mDataByteSize) / stride)
        guard frames > 0 else { return false }

        let rightBase = planar
            ? (buffers.count >= 2 ? (buffers[1].mData ?? firstData) : firstData)
            : (channels >= 2 ? firstData.advanced(by: sampleBytes) : firstData)
        var cursor = ringCursor
        for i in 0..<frames {
            let offset = i * stride
            ringLeft[cursor] = Self.decodeSample(firstData, offset: offset, bits: bits, isFloat: isFloat, isBig: isBig)
            ringRight[cursor] = Self.decodeSample(rightBase, offset: offset, bits: bits, isFloat: isFloat, isBig: isBig)
            cursor = (cursor + 1) & Self.ringMask
        }
        ringCursor = cursor
        return true
    }

    func computeSpectrum(into outBytes: inout [UInt8]) -> Bool {
        let bins = OutlineAudioSharedStore.spectrumBins
        guard let setup = fftSetup, outBytes.count >= bins * 2 else { return false }
        for n in 0..<Self.fftSize {
            let idx = (ringCursor + n) & Self.ringMask
            splitReal[n] = ringLeft[idx]
            splitImag[n] = ringRight[idx]
        }
        splitReal.withUnsafeMutableBufferPointer { re in
            splitImag.withUnsafeMutableBufferPointer { im in
                guard let rp = re.baseAddress, let ip = im.baseAddress else { return }
                vDSP_vmul(rp, 1, window, 1, rp, 1, vDSP_Length(Self.fftSize))
                vDSP_vmul(ip, 1, window, 1, ip, 1, vDSP_Length(Self.fftSize))
                var complex = DSPSplitComplex(realp: rp, imagp: ip)
                vDSP_fft_zip(setup, &complex, 1, Self.log2Fft, FFTDirection(kFFTDirection_Forward))
            }
        }

        let invTwoN: Float = 0.5 / Float(Self.fftSize)
        var nonZero = false
        for k in 1..<bins {
            let m = Self.fftSize - k
            let lMag = hypotf((splitReal[k] + splitReal[m]) * invTwoN, (splitImag[k] - splitImag[m]) * invTwoN)
            let rMag = hypotf((splitImag[k] + splitImag[m]) * invTwoN, (splitReal[m] - splitReal[k]) * invTwoN)
            let sL = Self.smoothing * smoothedLeft[k] + (1 - Self.smoothing) * lMag
            let sR = Self.smoothing * smoothedRight[k] + (1 - Self.smoothing) * rMag
            smoothedLeft[k] = sL
            smoothedRight[k] = sR
            let bL = Self.toDbByte(sL)
            let bR = Self.toDbByte(sR)
            outBytes[k] = bL
            outBytes[bins + k] = bR
            if bL != 0 || bR != 0 { nonZero = true }
        }
        return nonZero
    }

    private static func toDbByte(_ magnitude: Float) -> UInt8 {
        guard magnitude > minLinear else { return 0 }
        let scaled = Int(((20.0 * log10f(magnitude) + 80.0) * (255.0 / 70.0)))
        return UInt8(clamping: max(0, min(255, scaled)))
    }

    private static func decodeSample(_ base: UnsafeRawPointer, offset: Int, bits: Int, isFloat: Bool, isBig: Bool) -> Float {
        if isFloat && bits == 32 {
            let raw = base.loadUnaligned(fromByteOffset: offset, as: UInt32.self)
            let val = Float(bitPattern: isBig ? UInt32(bigEndian: raw) : UInt32(littleEndian: raw))
            return val.isFinite ? max(-1, min(1, val)) : 0
        }
        if bits == 16 {
            let raw = base.loadUnaligned(fromByteOffset: offset, as: Int16.self)
            return Float(isBig ? Int16(bigEndian: raw) : Int16(littleEndian: raw)) * (1.0 / 32768.0)
        }
        return 0
    }
}
