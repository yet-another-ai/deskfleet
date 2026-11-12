import AVFoundation
import Foundation
import Speech
import UIKit

/// Owns microphone capture and recognition for one client-side dictation at a time.
/// Public methods, lifecycle notifications, and result handling run on the main queue.
internal final class SpeechInput {
    private final class Session {
        let id: String
        let recognizer: SFSpeechRecognizer
        let engine = AVAudioEngine()
        let request = SFSpeechAudioBufferRecognitionRequest()
        var task: SFSpeechRecognitionTask?
        var startCompleted: (() -> Void)?
        var capturing = false
        var audioSessionActive = false
        var audioConfiguration: (category: AVAudioSession.Category, mode: AVAudioSession.Mode, options: AVAudioSession.CategoryOptions)?
        var stopping = false
        var stopTimeout: DispatchWorkItem?

        init(id: String, recognizer: SFSpeechRecognizer, completion: @escaping () -> Void) {
            self.id = id
            self.recognizer = recognizer
            self.startCompleted = completion
        }
    }

    private let emit: ([String: Any]) -> Void
    private var active: Session?
    private var observers: [NSObjectProtocol] = []
    private var disposed = false

    init(emit: @escaping ([String: Any]) -> Void) {
        self.emit = emit
        let center = NotificationCenter.default
        observers = [
            center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
                self?.cancelActive()
            },
            center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
                guard let kind = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                      kind == AVAudioSession.InterruptionType.began.rawValue,
                      let self, let session = self.active else { return }
                self.fail(session, code: "unavailable")
            }
        ]
    }

    func isSupported(locale: String) -> Bool {
        !disposed && SFSpeechRecognizer(locale: Locale(identifier: locale))?.isAvailable == true
    }

    func start(id: String, locale: String, completion: @escaping () -> Void) {
        cancelActive()
        guard !disposed,
              let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)),
              recognizer.isAvailable else {
            emit(["sessionId": id, "type": "error", "code": "unavailable"])
            emit(["sessionId": id, "type": "ended"])
            completion()
            return
        }
        let session = Session(id: id, recognizer: recognizer, completion: completion)
        active = session
        SFSpeechRecognizer.requestAuthorization { [weak self, weak session] authorization in
            DispatchQueue.main.async {
                guard let self, let session, self.active === session else { return }
                guard authorization == .authorized else {
                    self.fail(session, code: "permission-denied")
                    return
                }
                AVAudioSession.sharedInstance().requestRecordPermission { [weak self, weak session] granted in
                    DispatchQueue.main.async {
                        guard let self, let session, self.active === session else { return }
                        if granted { self.begin(session) }
                        else { self.fail(session, code: "permission-denied") }
                    }
                }
            }
        }
    }

    func stop(id: String) {
        guard let session = active, session.id == id, !session.stopping else { return }
        session.stopping = true
        if session.task == nil {
            finish(session)
            return
        }
        stopCapture(session)
        let timeout = DispatchWorkItem { [weak self, weak session] in
            guard let self, let session, self.active === session else { return }
            self.fail(session, code: "failed")
        }
        session.stopTimeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: timeout)
        session.request.endAudio()
        event(session, type: "level", fields: ["level": 0])
        // Keep the audio session configured until the final callback or deadline.
    }

    func cancel(id: String) {
        guard let session = active, session.id == id else { return }
        finish(session)
    }

    func dispose() {
        disposed = true
        cancelActive()
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers.removeAll()
    }

    private func begin(_ session: Session) {
        guard active === session else { return }
        do {
            let audioSession = AVAudioSession.sharedInstance()
            session.audioConfiguration = (audioSession.category, audioSession.mode, audioSession.categoryOptions)
            try audioSession.setCategory(.record, mode: .measurement)
            try audioSession.setActive(true)
            session.audioSessionActive = true
            session.request.shouldReportPartialResults = true
            session.recognizer.queue = .main
            session.task = session.recognizer.recognitionTask(with: session.request) { [weak self, weak session] result, error in
                guard let self, let session, self.active === session else { return }
                if let result {
                    let text = result.bestTranscription.formattedString
                    if result.isFinal && text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        self.fail(session, code: "no-speech")
                        return
                    }
                    self.event(session, type: "result", fields: ["text": text, "final": result.isFinal])
                    if result.isFinal {
                        self.finish(session)
                        return
                    }
                }
                if let error {
                    let code = (error as NSError).domain == NSURLErrorDomain ? "network" : "failed"
                    self.fail(session, code: code)
                }
            }

            let input = session.engine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else {
                fail(session, code: "unavailable")
                return
            }
            let request = session.request
            var lastLevelTime = 0.0
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self, weak session] buffer, _ in
                request.append(buffer)
                let now = ProcessInfo.processInfo.systemUptime
                guard now - lastLevelTime >= 0.05,
                      let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
                lastLevelTime = now
                var energy: Float = 0
                for index in 0..<Int(buffer.frameLength) { energy += samples[index] * samples[index] }
                let rms = sqrt(energy / Float(buffer.frameLength))
                let level = min(1.0, max(0.0, Double((20 * log10(max(rms, 0.000_001)) + 60) / 60)))
                DispatchQueue.main.async {
                    guard let self, let session, !session.stopping else { return }
                    self.event(session, type: "level", fields: ["level": level])
                }
            }
            session.capturing = true
            session.engine.prepare()
            try session.engine.start()
            event(session, type: "started")
            completeStart(session)
        } catch {
            fail(session, code: "failed")
        }
    }

    private func stopCapture(_ session: Session) {
        if session.capturing {
            session.engine.stop()
            session.engine.inputNode.removeTap(onBus: 0)
            session.capturing = false
        }
    }

    private func releaseAudioSession(_ session: Session) {
        let audioSession = AVAudioSession.sharedInstance()
        if session.audioSessionActive {
            try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
            session.audioSessionActive = false
        }
        // Category changes survive deactivation, including when activation itself failed.
        if let previous = session.audioConfiguration {
            session.audioConfiguration = nil
            try? audioSession.setCategory(previous.category, mode: previous.mode, options: previous.options)
        }
    }

    private func cancelActive() {
        if let session = active { finish(session) }
    }

    private func completeStart(_ session: Session) {
        let completion = session.startCompleted
        session.startCompleted = nil
        completion?()
    }

    private func finish(_ session: Session) {
        guard active === session else { return }
        active = nil
        session.stopTimeout?.cancel()
        session.stopTimeout = nil
        stopCapture(session)
        session.request.endAudio()
        session.task?.cancel()
        session.task = nil
        releaseAudioSession(session)
        completeStart(session)
        emit(["sessionId": session.id, "type": "ended"])
    }

    private func fail(_ session: Session, code: String) {
        event(session, type: "error", fields: ["code": code])
        finish(session)
    }

    private func event(_ session: Session, type: String, fields: [String: Any] = [:]) {
        guard active === session else { return }
        emit(fields.merging(["sessionId": session.id, "type": type]) { _, value in value })
    }
}
