import Foundation

struct LocalFilesError: LocalizedError {
    let message: String
    var code: String? = nil
    var errorDescription: String? { message }
}

/// The bridge serializes operations; only cancellation is accessed across queues.
final class LocalFilesEndpoint: @unchecked Sendable {
    static let chunkBytes = 127 * 1024
    private let fm = FileManager.default
    private let cancellationLock = NSLock()
    private var cancelled = Set<String>()
    private var closed = false
    private var roots: [String: URL]
    private var scopedRoots: [URL] = []
    private let startAccess: (URL) -> Bool
    private let stopAccess: (URL) -> Void
    private var selected = "/Documents"
    private let staging: URL
    private var reads: [String: Read] = [:]
    private var uploads: [String: Upload] = [:]

    private struct Read {
        let path: String
        let handle: FileHandle
        let size: UInt64
        let modified: Double
        let identity: UInt64
    }
    private final class Upload {
        let directory: String
        let requestedName: String
        var name: String
        let kind: String
        let conflict: String
        let stage: URL
        var files: [String: (handle: FileHandle, offset: UInt64)] = [:]
        var finished = Set<String>()
        init(directory: String, name: String, kind: String, conflict: String, stage: URL) {
            self.directory = directory; self.requestedName = name; self.name = name
            self.kind = kind; self.conflict = conflict; self.stage = stage
        }
    }

    init(documents: URL, cache: URL,
         startAccess: @escaping (URL) -> Bool = { $0.startAccessingSecurityScopedResource() },
         stopAccess: @escaping (URL) -> Void = { $0.stopAccessingSecurityScopedResource() }) throws {
        self.startAccess = startAccess; self.stopAccess = stopAccess
        roots = ["/Documents": documents.standardizedFileURL.resolvingSymlinksInPath()]
        staging = cache.appendingPathComponent("deskfleet-files-\(UUID().uuidString)", isDirectory: true)
        try fm.createDirectory(at: documents, withIntermediateDirectories: true)
        try fm.createDirectory(at: staging, withIntermediateDirectories: true)
    }

    func cancel(_ transfer: String? = nil) {
        cancellationLock.lock(); defer { cancellationLock.unlock() }
        if let transfer { cancelled.insert(transfer) } else { closed = true }
    }

    private func check(_ transfer: String? = nil) throws {
        cancellationLock.lock(); defer { cancellationLock.unlock() }
        if closed { throw LocalFilesError(message: "Local file access is closed") }
        if let transfer, cancelled.contains(transfer) { throw LocalFilesError(message: "File transfer cancelled") }
    }

    func addRoot(_ url: URL) throws -> [String: Any] {
        try check()
        let scoped = startAccess(url)
        var retained = false
        defer { if scoped && !retained { stopAccess(url) } }
        let canonical = url.standardizedFileURL.resolvingSymlinksInPath()
        // The picker can return our own Documents without a security scope.
        // External selections still require a successful OS grant.
        let documents = roots["/Documents"]!
        let local = canonical.path == documents.path || canonical.path.hasPrefix(documents.path + "/")
        guard scoped || local else { throw LocalFilesError(message: "Cannot access the selected folder") }
        try coordinated(canonical) { value in
            guard try kind(value) == "directory" else { throw LocalFilesError(message: "A folder is required") }
        }
        let existing = roots.first(where: { $0.value.path == canonical.path })?.key
        let previous = selected
        let path: String
        if let existing { path = existing }
        else {
            let name = url.lastPathComponent
            // Virtual root labels are independent of provider filenames.
            let label = name.isEmpty || name.contains(":") || name.contains("\\") ? "Folder" : name
            var candidate = "/\(label)"
            var suffix = 2
            while roots[candidate] != nil { candidate = "/\(label) (\(suffix))"; suffix += 1 }
            path = candidate
            roots[path] = canonical
        }
        selected = path
        do {
            let listing = try list(path, strict: false)
            if existing == nil && scoped { scopedRoots.append(url); retained = true }
            return listing
        } catch {
            selected = previous
            if existing == nil { roots.removeValue(forKey: path) }
            throw error
        }
    }

    private func segments(_ path: String) throws -> [String] {
        if path.isEmpty { return [] }
        let parts = path.components(separatedBy: "/")
        guard parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && !$0.contains("\\") && !$0.contains(":") && !$0.contains("\0") }) else {
            throw LocalFilesError(message: "Invalid transfer path")
        }
        return parts
    }

    private func url(_ path: String) throws -> URL {
        guard let root = roots.keys.filter({ path == $0 || path.hasPrefix($0 + "/") }).max(by: { $0.count < $1.count }), let base = roots[root] else {
            throw LocalFilesError(message: "Folder access has not been granted")
        }
        var result = base
        let relative = String(path.dropFirst(root.count)).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        for segment in try segments(relative) { result.appendPathComponent(segment) }
        let canonical = result.standardizedFileURL.resolvingSymlinksInPath()
        guard canonical.path == base.path || canonical.path.hasPrefix(base.path + "/") else {
            throw LocalFilesError(message: "File is outside the selected folder")
        }
        return result
    }

    private func coordinated<T>(_ url: URL, write: Bool = false, _ operation: (URL) throws -> T) throws -> T {
        var coordinationError: NSError?
        var result: Result<T, Error>?
        let accessor: (URL) -> Void = { value in result = Result { try operation(value) } }
        let coordinator = NSFileCoordinator()
        if write { coordinator.coordinate(writingItemAt: url, options: [], error: &coordinationError, byAccessor: accessor) }
        else { coordinator.coordinate(readingItemAt: url, options: [], error: &coordinationError, byAccessor: accessor) }
        if let coordinationError { throw coordinationError }
        guard let result else { throw LocalFilesError(message: "File coordination did not complete") }
        return try result.get()
    }

    private func kind(_ url: URL) throws -> String {
        let attributes = try fm.attributesOfItem(atPath: url.path)
        switch attributes[.type] as? FileAttributeType {
        case .typeRegular: return "file"
        case .typeDirectory: return "directory"
        default: throw LocalFilesError(message: "Symbolic links and special files are not supported")
        }
    }

    private func entry(_ url: URL, path: String) throws -> [String: Any] {
        let attributes = try fm.attributesOfItem(atPath: url.path)
        return ["path": path, "name": url.lastPathComponent, "kind": try kind(url),
                "size": (attributes[.size] as? NSNumber)?.uint64Value ?? 0,
                "modifiedAt": ((attributes[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0) * 1000]
    }

    private func list(_ path: String, strict: Bool) throws -> [String: Any] {
        let directory = try url(path)
        return try coordinated(directory) { directory in
            guard try kind(directory) == "directory" else { throw LocalFilesError(message: "A folder is required") }
            var entries: [[String: Any]] = []
            for child in try fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) {
                try check()
                do { entries.append(try entry(child, path: path + "/" + child.lastPathComponent)) }
                catch { if strict { throw error } }
            }
            entries.sort { left, right in
                if left["kind"] as? String != right["kind"] as? String { return left["kind"] as? String == "directory" }
                return (left["name"] as? String ?? "").localizedStandardCompare(right["name"] as? String ?? "") == .orderedAscending
            }
            return ["path": path, "parentPath": roots[path] == nil ? String(path.prefix(upTo: path.lastIndex(of: "/")!)) as Any : NSNull(),
                    "homePath": selected, "roots": roots.keys.sorted().map { ["path": $0, "name": String($0.dropFirst())] }, "entries": entries]
        }
    }

    private func string(_ params: [String: Any], _ key: String) throws -> String {
        guard let value = params[key] as? String else { throw LocalFilesError(message: "Missing \(key)") }
        return value
    }

    private func number(_ params: [String: Any], _ key: String, max: UInt64 = 9_007_199_254_740_991) throws -> UInt64 {
        guard let value = params[key] as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue >= 0,
              value.doubleValue <= Double(max), value.doubleValue.rounded(.towardZero) == value.doubleValue else {
            throw LocalFilesError(message: "Invalid \(key)")
        }
        return value.uint64Value
    }

    private func openRead(_ params: [String: Any]) throws -> Read {
        let path = try string(params, "path")
        return try coordinated(url(path)) { file in
            guard try kind(file) == "file" else { throw LocalFilesError(message: "A file is required") }
            let attributes = try fm.attributesOfItem(atPath: file.path)
            let modified = ((attributes[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0) * 1000
            if let expected = params["modifiedAt"] as? NSNumber, expected.doubleValue != modified {
                throw LocalFilesError(message: "File changed during transfer")
            }
            return Read(path: path, handle: try FileHandle(forReadingFrom: file), size: (attributes[.size] as? NSNumber)?.uint64Value ?? 0,
                        modified: modified, identity: (attributes[.systemFileNumber] as? NSNumber)?.uint64Value ?? 0)
        }
    }

    private func validate(_ read: Read, at file: URL) throws {
        let attributes = try fm.attributesOfItem(atPath: file.path)
        guard (attributes[.size] as? NSNumber)?.uint64Value == read.size,
              (attributes[.systemFileNumber] as? NSNumber)?.uint64Value == read.identity,
              ((attributes[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0) * 1000 == read.modified else {
            throw LocalFilesError(message: "File changed during transfer")
        }
    }

    private func unusedName(_ directory: URL, name: String, kind: String) -> String {
        if !fm.fileExists(atPath: directory.appendingPathComponent(name).path) { return name }
        let extensionIndex = kind == "file" ? name.lastIndex(of: ".") : nil
        let split = extensionIndex.flatMap { $0 == name.startIndex ? nil : $0 }
        let stem = split.map { String(name[..<$0]) } ?? name
        let suffix = split.map { String(name[$0...]) } ?? ""
        var index = 1
        while fm.fileExists(atPath: directory.appendingPathComponent("\(stem) (\(index))\(suffix)").path) { index += 1 }
        return "\(stem) (\(index))\(suffix)"
    }

    private func conflict() -> LocalFilesError { LocalFilesError(message: "A file or folder with this name already exists", code: "conflict") }

    private func stagePath(_ upload: Upload, path: String) throws -> URL {
        let parts = try segments(path)
        if upload.kind == "file", !parts.isEmpty { throw LocalFilesError(message: "Invalid root file path") }
        var destination = upload.stage.appendingPathComponent("item")
        for part in parts { destination.appendPathComponent(part) }
        return destination
    }

    private func remove(_ id: String) throws {
        guard let upload = uploads.removeValue(forKey: id) else { return }
        for file in upload.files.values { try? file.handle.close() }
        try fm.removeItem(at: upload.stage)
        cancellationLock.lock(); cancelled.remove(id); cancellationLock.unlock()
    }

    private func copy(_ source: URL, to destination: URL, transfer: String) throws {
        try check(transfer)
        if try kind(source) == "directory" {
            try fm.createDirectory(at: destination, withIntermediateDirectories: false)
            for child in try fm.contentsOfDirectory(at: source, includingPropertiesForKeys: nil) {
                try copy(child, to: destination.appendingPathComponent(child.lastPathComponent), transfer: transfer)
            }
        } else {
            guard fm.createFile(atPath: destination.path, contents: nil, attributes: [.posixPermissions: 0o600]) else { throw LocalFilesError(message: "Cannot create destination file") }
            let input = try FileHandle(forReadingFrom: source)
            defer { try? input.close() }
            let output = try FileHandle(forWritingTo: destination)
            defer { try? output.close() }
            while true {
                try check(transfer)
                guard let bytes = try input.read(upToCount: Self.chunkBytes), !bytes.isEmpty else { break }
                try output.write(contentsOf: bytes)
            }
        }
    }

    func call(_ method: String, params: [String: Any], data: String?) throws -> [String: Any] {
        try check(method == "abort" ? nil : params["transferId"] as? String)
        switch method {
        case "list": return ["value": try list(params["path"] as? String ?? selected, strict: params["strict"] as? Bool ?? false)]
        case "stat":
            let path = try string(params, "path")
            return ["value": try coordinated(url(path)) { try entry($0, path: path) }]
        case "resolve": throw LocalFilesError(message: "Agent resources belong to the executing machine")
        case "openRead":
            guard reads.count < 32 else { throw LocalFilesError(message: "Too many open file reads") }
            let id = UUID().uuidString; reads[id] = try openRead(params)
            return ["value": ["readId": id]]
        case "closeRead":
            if let read = reads.removeValue(forKey: try string(params, "readId")) {
                defer { try? read.handle.close() }
                try coordinated(url(read.path)) { try validate(read, at: $0) }
            }
            return ["value": NSNull()]
        case "read":
            let offset = try number(params, "offset"), length = try number(params, "length", max: UInt64(Self.chunkBytes))
            let read: Read
            if let id = params["readId"] as? String {
                guard let session = reads[id] else { throw LocalFilesError(message: "Unknown file read") }
                read = session
            } else { read = try openRead(params) }
            defer { if params["readId"] == nil { try? read.handle.close() } }
            guard try string(params, "path") == read.path else { throw LocalFilesError(message: "File read path does not match its session") }
            if let modified = params["modifiedAt"] as? NSNumber, modified.doubleValue != read.modified { throw LocalFilesError(message: "File changed during transfer") }
            let bytes = try coordinated(url(read.path)) { file in
                try validate(read, at: file)
                try read.handle.seek(toOffset: offset)
                return try read.handle.read(upToCount: Int(length)) ?? Data()
            }
            return ["value": ["bytes": bytes.count], "data": bytes.base64EncodedString()]
        case "begin":
            let directory = try string(params, "directory"), name = try string(params, "name")
            let kind = try string(params, "kind"), policy = try string(params, "conflict")
            guard try segments(name).count == 1, ["file", "directory"].contains(kind), ["ask", "replace", "rename", "skip"].contains(policy) else { throw LocalFilesError(message: "Invalid file transfer") }
            return try coordinated(url(directory)) { destination in
                guard try self.kind(destination) == "directory" else { throw LocalFilesError(message: "A folder is required") }
                let existing = destination.appendingPathComponent(name)
                if fm.fileExists(atPath: existing.path) {
                    if policy == "skip" { return ["value": ["transferId": "", "skipped": true]] }
                    if policy == "ask" { throw conflict() }
                    if policy == "replace", try kind != "file" || self.kind(existing) != "file" { throw conflict() }
                }
                let id = UUID().uuidString, stage = staging.appendingPathComponent(UUID().uuidString)
                try fm.createDirectory(at: stage, withIntermediateDirectories: false)
                let upload = Upload(directory: directory, name: name, kind: kind, conflict: policy, stage: stage)
                if policy == "rename" { upload.name = unusedName(destination, name: name, kind: kind) }
                do {
                    if kind == "directory" { try fm.createDirectory(at: stage.appendingPathComponent("item"), withIntermediateDirectories: false) }
                } catch { try? fm.removeItem(at: stage); throw error }
                uploads[id] = upload
                return ["value": ["transferId": id, "skipped": false]]
            }
        case "abort":
            try remove(string(params, "transferId")); return ["value": NSNull()]
        default:
            let id = try string(params, "transferId")
            guard let upload = uploads[id] else { throw LocalFilesError(message: "Unknown file transfer") }
            switch method {
            case "mkdir":
                guard upload.kind == "directory" else { throw LocalFilesError(message: "A directory transfer is required") }
                try fm.createDirectory(at: stagePath(upload, path: string(params, "path")), withIntermediateDirectories: true)
                return ["value": NSNull()]
            case "write":
                let path = try string(params, "path"), offset = try number(params, "offset")
                guard let data, data.count <= ((Self.chunkBytes + 2) / 3) * 4, let bytes = Data(base64Encoded: data), bytes.count <= Self.chunkBytes,
                      !upload.finished.contains(path), upload.kind == "file" || !path.isEmpty else { throw LocalFilesError(message: "Invalid file write") }
                if upload.files[path] == nil {
                    guard offset == 0 else { throw LocalFilesError(message: "File writes must start at zero") }
                    let file = try stagePath(upload, path: path)
                    guard fm.createFile(atPath: file.path, contents: nil, attributes: [.posixPermissions: 0o600]) else { throw LocalFilesError(message: "Cannot create staging file") }
                    upload.files[path] = (try FileHandle(forWritingTo: file), 0)
                }
                guard var file = upload.files[path], file.offset == offset else { throw LocalFilesError(message: "File writes must be sequential") }
                try file.handle.write(contentsOf: bytes); file.offset += UInt64(bytes.count); upload.files[path] = file
                return ["value": ["bytes": bytes.count]]
            case "finish":
                let path = try string(params, "path"), size = try number(params, "size")
                guard let file = upload.files[path], file.offset == size else { throw LocalFilesError(message: "File size does not match the received bytes") }
                try file.handle.close(); upload.files.removeValue(forKey: path); upload.finished.insert(path)
                return ["value": NSNull()]
            case "commit": return try commit(id, upload: upload)
            default: throw LocalFilesError(message: "Unknown file method")
            }
        }
    }

    private func commit(_ id: String, upload: Upload) throws -> [String: Any] {
        guard upload.files.isEmpty, upload.kind == "directory" || upload.finished.contains("") else { throw LocalFilesError(message: "Transfer has unfinished files") }
        let value: [String: Any] = try coordinated(url(upload.directory), write: true) { directory in
            try check(id)
            if upload.conflict == "rename" { upload.name = unusedName(directory, name: upload.requestedName, kind: upload.kind) }
            let destination = directory.appendingPathComponent(upload.name)
            let exists = fm.fileExists(atPath: destination.path)
            let path = upload.directory + "/" + upload.name
            if exists, upload.conflict == "skip" { return ["path": path, "skipped": true] }
            if exists {
                guard upload.conflict == "replace", upload.kind == "file", try kind(destination) == "file" else { throw conflict() }
            }
            // Publish from a private sibling on the provider's filesystem. Cleanup
            // owns this temporary name only, never a possibly published destination.
            let temporary = directory.appendingPathComponent(".deskfleet-transfer-\(UUID().uuidString)")
            defer { try? fm.removeItem(at: temporary) }
            try copy(upload.stage.appendingPathComponent("item"), to: temporary, transfer: id)
            try check(id)
            do {
                if exists { _ = try fm.replaceItemAt(destination, withItemAt: temporary) }
                else { try fm.moveItem(at: temporary, to: destination) }
            } catch {
                throw LocalFilesError(message: "File publication did not finish. Files already saved in the destination have been kept. \(error.localizedDescription)", code: "partial_copy")
            }
            return ["path": path]
        }
        try remove(id)
        return ["value": value]
    }

    func close() throws {
        cancel()
        for read in reads.values { try? read.handle.close() }
        reads.removeAll()
        for upload in uploads.values { for file in upload.files.values { try? file.handle.close() } }
        uploads.removeAll()
        defer {
            for root in scopedRoots { stopAccess(root) }
            scopedRoots.removeAll(); roots.removeAll()
        }
        try fm.removeItem(at: staging)
    }
}
