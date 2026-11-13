import Capacitor
import Foundation
import UIKit
import UniformTypeIdentifiers

/// Owns document-picker presentation and page/account-scoped native endpoints.
final class LocalFilesBridge: NSObject, UIDocumentPickerDelegate, @unchecked Sendable {
    private final class Session: @unchecked Sendable {
        let endpoint: LocalFilesEndpoint
        let queue = DispatchQueue(label: "ai.yetanother.deskfleet.files", qos: .userInitiated)
        init(_ endpoint: LocalFilesEndpoint) { self.endpoint = endpoint }
    }
    private let lock = NSLock()
    private var sessions: [String: Session] = [:]
    // Picker state is confined to the main queue.
    private var picker: UIDocumentPickerViewController?
    private var pending: (id: String, call: CAPPluginCall, session: Session)?

    private func reject(_ call: CAPPluginCall, _ error: Error) {
        call.reject(error.localizedDescription, (error as? LocalFilesError)?.code, error)
    }

    private func session(_ call: CAPPluginCall) -> Session? {
        lock.lock(); defer { lock.unlock() }
        guard let id = call.getString("id"), let session = sessions[id] else {
            call.reject("Local file access is closed"); return nil
        }
        return session
    }

    func open(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else { return call.reject("Missing file endpoint ID") }
        lock.lock(); defer { lock.unlock() }
        guard sessions[id] == nil else { return call.reject("File endpoint already exists") }
        do {
            let fm = FileManager.default
            let documents = try fm.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            let cache = try fm.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            sessions[id] = Session(try LocalFilesEndpoint(documents: documents, cache: cache))
            call.resolve()
        } catch { reject(call, error) }
    }

    func perform(_ call: CAPPluginCall) {
        guard let session = session(call), let method = call.getString("method"), let params = call.getObject("params") else {
            if call.getString("method") == nil || call.getObject("params") == nil { call.reject("Missing file operation") }
            return
        }
        // Interrupt a long provider copy before joining its serial work queue.
        if method == "abort", let transfer = params["transferId"] as? String { session.endpoint.cancel(transfer) }
        let data = call.getString("data")
        session.queue.async {
            do { call.resolve(try session.endpoint.call(method, params: params, data: data)) }
            catch { self.reject(call, error) }
        }
    }

    func choose(_ call: CAPPluginCall, presenter: @escaping () -> UIViewController?) {
        guard let session = session(call), let id = call.getString("id") else { return }
        DispatchQueue.main.async {
            guard self.pending == nil else { return call.reject("A folder picker is already open") }
            guard var root = presenter() else { return call.reject("Folder picker is unavailable") }
            self.lock.lock()
            let active = self.sessions[id] === session
            self.lock.unlock()
            guard active else { return call.reject("Local file access is closed") }
            while let next = root.presentedViewController, !next.isBeingDismissed { root = next }
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)
            picker.allowsMultipleSelection = false
            picker.delegate = self
            self.picker = picker; self.pending = (id, call, session)
            root.present(picker, animated: true)
        }
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        guard controller === picker else { return }
        let call = pending?.call
        pending = nil; picker = nil
        call?.resolve(["value": NSNull()])
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard controller === picker, let selection = pending else { return }
        pending = nil; picker = nil
        guard let url = urls.first else { return selection.call.resolve(["value": NSNull()]) }
        selection.session.queue.async {
            do { selection.call.resolve(["value": try selection.session.endpoint.addRoot(url)]) }
            catch { self.reject(selection.call, error) }
        }
    }

    private func cancelPicker(_ id: String? = nil) {
        DispatchQueue.main.async {
            guard let pending = self.pending, id == nil || pending.id == id else { return }
            self.pending = nil
            self.picker?.dismiss(animated: false); self.picker = nil
            pending.call.reject("Local file access is closed")
        }
    }

    func close(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { return call.reject("Missing file endpoint ID") }
        lock.lock(); let session = sessions.removeValue(forKey: id); lock.unlock()
        cancelPicker(id)
        guard let session else { return call.resolve() }
        session.endpoint.cancel()
        session.queue.async {
            do { try session.endpoint.close(); call.resolve() }
            catch { self.reject(call, error) }
        }
    }

    func dispose() {
        lock.lock(); let previous = Array(sessions.values); sessions.removeAll(); lock.unlock()
        cancelPicker()
        for session in previous {
            session.endpoint.cancel()
            session.queue.async { try? session.endpoint.close() }
        }
    }
}
