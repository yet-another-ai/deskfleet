import Darwin
import Foundation

/// Cross-process 512-byte memory-mapped spectrum file inside the shared App Group container.
final class OutlineAudioSharedStore {
    static let appGroupId = "group.ai.yetanother.deskfleet"
    static let spectrumBins = 224
    static let stereoSpectrumBytes = spectrumBins * 2
    static let heartbeatTimeoutMs: UInt64 = 5_000

    private static let fileSize = 512
    private static let offStopReq = 0
    private static let offSampleRate = 4
    private static let offHeartbeat = 8
    private static let offAudioTs = 16
    private static let offSpectrum = 24

    private let fd: Int32
    private let ptr: UnsafeMutableRawPointer

    static func nowMs() -> UInt64 {
        UInt64(ProcessInfo.processInfo.systemUptime * 1000.0)
    }

    init?() {
        guard let container = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: Self.appGroupId
        ) else { return nil }
        let caches = container.appendingPathComponent("Library/Caches", isDirectory: true)
        try? FileManager.default.createDirectory(at: caches, withIntermediateDirectories: true)
        let url = caches.appendingPathComponent("outline-audio.bin", isDirectory: false)

        let fd = url.path.withCString { Darwin.open($0, O_RDWR | O_CREAT, S_IRUSR | S_IWUSR) }
        guard fd >= 0 else { return nil }
        var st = Darwin.stat()
        if Darwin.fstat(fd, &st) != 0 || Int(st.st_size) < Self.fileSize {
            if Darwin.ftruncate(fd, off_t(Self.fileSize)) != 0 {
                Darwin.close(fd)
                return nil
            }
        }
        guard let mapped = Darwin.mmap(nil, Self.fileSize, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0),
              mapped != MAP_FAILED else {
            Darwin.close(fd)
            return nil
        }
        self.fd = fd
        self.ptr = mapped
    }

    deinit {
        Darwin.munmap(ptr, Self.fileSize)
        Darwin.close(fd)
    }

    func markBroadcastStarted() {
        ptr.storeBytes(of: UInt32(0), toByteOffset: Self.offStopReq, as: UInt32.self)
        ptr.storeBytes(of: UInt64(0), toByteOffset: Self.offAudioTs, as: UInt64.self)
        ptr.storeBytes(of: max(1, Self.nowMs()), toByteOffset: Self.offHeartbeat, as: UInt64.self)
    }

    func markBroadcastStopped() {
        ptr.storeBytes(of: UInt64(0), toByteOffset: Self.offHeartbeat, as: UInt64.self)
        ptr.storeBytes(of: UInt32(0), toByteOffset: Self.offStopReq, as: UInt32.self)
    }

    func updateHeartbeat(_ ts: UInt64 = OutlineAudioSharedStore.nowMs()) {
        ptr.storeBytes(of: max(1, ts), toByteOffset: Self.offHeartbeat, as: UInt64.self)
    }

    func setStopRequested(_ requested: Bool) {
        ptr.storeBytes(of: UInt32(requested ? 1 : 0), toByteOffset: Self.offStopReq, as: UInt32.self)
    }

    var isStopRequested: Bool {
        ptr.load(fromByteOffset: Self.offStopReq, as: UInt32.self) != 0
    }

    func writeSpectrum(_ spectrum: [UInt8], sampleRate: Int, timestampMs: UInt64 = OutlineAudioSharedStore.nowMs()) {
        spectrum.withUnsafeBytes { raw in
            if let base = raw.baseAddress {
                memcpy(ptr.advanced(by: Self.offSpectrum), base, min(Self.stereoSpectrumBytes, raw.count))
            }
        }
        let ts = max(1, timestampMs)
        ptr.storeBytes(of: UInt32(max(0, sampleRate)), toByteOffset: Self.offSampleRate, as: UInt32.self)
        ptr.storeBytes(of: ts, toByteOffset: Self.offAudioTs, as: UInt64.self)
        ptr.storeBytes(of: ts, toByteOffset: Self.offHeartbeat, as: UInt64.self)
    }

    func isCurrentlyActive(nowMs: UInt64 = OutlineAudioSharedStore.nowMs()) -> Bool {
        let heartbeat = ptr.load(fromByteOffset: Self.offHeartbeat, as: UInt64.self)
        return heartbeat > 0 && nowMs >= heartbeat && (nowMs - heartbeat) <= Self.heartbeatTimeoutMs
    }

    func readState(
        nowMs: UInt64 = OutlineAudioSharedStore.nowMs(),
        lastAudioTs: inout UInt64
    ) -> (alive: Bool, sampleRate: Int, binsBase64: String?) {
        let heartbeat = ptr.load(fromByteOffset: Self.offHeartbeat, as: UInt64.self)
        guard heartbeat > 0 else { return (false, 0, nil) }
        guard nowMs >= heartbeat && (nowMs - heartbeat) <= Self.heartbeatTimeoutMs else {
            markBroadcastStopped()
            return (false, 0, nil)
        }
        let audioTs = ptr.load(fromByteOffset: Self.offAudioTs, as: UInt64.self)
        let sampleRate = Int(ptr.load(fromByteOffset: Self.offSampleRate, as: UInt32.self))
        guard audioTs > 0 && audioTs != lastAudioTs && sampleRate > 0 else {
            return (true, sampleRate, nil)
        }
        lastAudioTs = audioTs
        let encoded = Data(bytes: ptr.advanced(by: Self.offSpectrum), count: Self.stereoSpectrumBytes)
            .base64EncodedString()
        return (true, sampleRate, encoded)
    }
}
