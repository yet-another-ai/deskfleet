import Foundation
import XCTest
@testable import DeskFleetLocalFiles

// Run with `mise exec -- node packages/capacitor-bridge/ios/Tests/run.ts`.
// This Foundation-only suite does not build the viewer XCFramework.
final class LocalFilesEndpointTests: XCTestCase {
    private var folder: URL!
    private var documents: URL!
    private var endpoint: LocalFilesEndpoint!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        documents = folder.appendingPathComponent("Documents")
        endpoint = try LocalFilesEndpoint(documents: documents, cache: folder)
    }

    override func tearDownWithError() throws {
        try? endpoint.close()
        try FileManager.default.removeItem(at: folder)
    }

    private func call(_ method: String, _ params: [String: Any] = [:], data: Data? = nil) throws -> Any {
        try endpoint.call(method, params: params, data: data?.base64EncodedString())["value"]!
    }

    private func begin(_ name: String = "file.txt", kind: String = "file", conflict: String = "ask") throws -> String {
        let value = try call("begin", ["directory": "/Documents", "name": name, "kind": kind, "conflict": conflict])
        let result = try XCTUnwrap(value as? [String: Any])
        return try XCTUnwrap(result["transferId"] as? String)
    }

    private func write(_ id: String, _ text: String, path: String = "") throws {
        let bytes = Data(text.utf8)
        _ = try call("write", ["transferId": id, "path": path, "offset": 0], data: bytes)
        _ = try call("finish", ["transferId": id, "path": path, "size": bytes.count])
    }

    func testDefaultFolderAndBoundedRead() throws {
        try Data("hello".utf8).write(to: documents.appendingPathComponent("hello.txt"))
        let listing = try XCTUnwrap(call("list") as? [String: Any])
        XCTAssertEqual(listing["path"] as? String, "/Documents")
        XCTAssertTrue(listing["parentPath"] is NSNull)
        XCTAssertThrowsError(try call("stat", ["path": "/Documents/missing"]))
        XCTAssertThrowsError(try call("openRead", ["path": "/Documents/missing"]))
        let read = try XCTUnwrap(call("openRead", ["path": "/Documents/hello.txt"]) as? [String: Any])
        let id = try XCTUnwrap(read["readId"] as? String)
        let reply = try endpoint.call("read", params: ["path": "/Documents/hello.txt", "readId": id, "offset": 1, "length": 3], data: nil)
        XCTAssertEqual(Data(base64Encoded: try XCTUnwrap(reply["data"] as? String)), Data("ell".utf8))
        XCTAssertThrowsError(try call("read", ["path": "/Documents/hello.txt", "readId": id, "offset": 0, "length": LocalFilesEndpoint.chunkBytes + 1]))
        try Data("changed".utf8).write(to: documents.appendingPathComponent("hello.txt"))
        XCTAssertThrowsError(try call("closeRead", ["readId": id]))
        XCTAssertThrowsError(try call("read", ["path": "/Documents/hello.txt", "readId": id, "offset": 0, "length": 1]))
    }

    func testFilePublicationConflictRenameAndReplace() throws {
        let first = try begin()
        try write(first, "first")
        XCTAssertFalse(FileManager.default.fileExists(atPath: documents.appendingPathComponent("file.txt").path))
        _ = try call("commit", ["transferId": first])
        XCTAssertThrowsError(try begin()) { XCTAssertEqual(($0 as? LocalFilesError)?.code, "conflict") }
        let second = try begin(conflict: "rename")
        try write(second, "second")
        let renamed = try XCTUnwrap(call("commit", ["transferId": second]) as? [String: Any])
        XCTAssertEqual(renamed["path"] as? String, "/Documents/file (1).txt")
        let replacement = try begin(conflict: "replace")
        try write(replacement, "replacement")
        _ = try call("commit", ["transferId": replacement])
        XCTAssertEqual(try String(contentsOf: documents.appendingPathComponent("file.txt"), encoding: .utf8), "replacement")
        XCTAssertEqual(try String(contentsOf: documents.appendingPathComponent("file (1).txt"), encoding: .utf8), "second")
        let skipped = try XCTUnwrap(call("begin", ["directory": "/Documents", "name": "file.txt", "kind": "file", "conflict": "skip"]) as? [String: Any])
        XCTAssertEqual(skipped["skipped"] as? Bool, true)
    }

    func testDirectoryTransferAndSequentialWrites() throws {
        let id = try begin("folder", kind: "directory")
        _ = try call("mkdir", ["transferId": id, "path": "empty"])
        XCTAssertThrowsError(try call("write", ["transferId": id, "path": "file", "offset": 1], data: Data([1])))
        _ = try call("write", ["transferId": id, "path": "file", "offset": 0], data: Data([1]))
        XCTAssertThrowsError(try call("commit", ["transferId": id]))
        XCTAssertThrowsError(try call("finish", ["transferId": id, "path": "file", "size": 2]))
        _ = try call("finish", ["transferId": id, "path": "file", "size": 1])
        XCTAssertThrowsError(try call("write", ["transferId": id, "path": "file", "offset": 1], data: Data([2])))
        _ = try call("commit", ["transferId": id])
        XCTAssertEqual(try Data(contentsOf: documents.appendingPathComponent("folder/file")), Data([1]))
        XCTAssertTrue(FileManager.default.fileExists(atPath: documents.appendingPathComponent("folder/empty").path))
    }

    func testTraversalSymlinksAndCancellation() throws {
        XCTAssertThrowsError(try call("list", ["path": "/Documents/../outside"]))
        let outside = folder.appendingPathComponent("outside")
        try Data("private".utf8).write(to: outside)
        try FileManager.default.createSymbolicLink(at: documents.appendingPathComponent("link"), withDestinationURL: outside)
        XCTAssertThrowsError(try call("stat", ["path": "/Documents/link"]))
        XCTAssertThrowsError(try call("list", ["path": "/Documents", "strict": true]))
        let id = try begin("cancelled")
        XCTAssertThrowsError(try call("write", ["transferId": id, "path": "../escape", "offset": 0], data: Data([1])))
        try write(id, "not published")
        endpoint.cancel(id)
        XCTAssertThrowsError(try call("commit", ["transferId": id]))
        _ = try call("abort", ["transferId": id])
        XCTAssertFalse(FileManager.default.fileExists(atPath: documents.appendingPathComponent("cancelled").path))
        try endpoint.close()
        XCTAssertThrowsError(try call("list"))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: folder.path).sorted(), ["Documents", "outside"])
    }

    func testPickingAppDocumentsWithoutExternalScope() throws {
        try endpoint.close()
        var releases = 0
        endpoint = try LocalFilesEndpoint(documents: documents, cache: folder, startAccess: { _ in false }, stopAccess: { _ in releases += 1 })
        XCTAssertEqual(try endpoint.addRoot(documents)["path"] as? String, "/Documents")
        let nested = documents.appendingPathComponent("Nested")
        try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: false)
        XCTAssertEqual(try endpoint.addRoot(nested)["path"] as? String, "/Nested")
        let external = folder.appendingPathComponent("Documents-ungranted")
        try FileManager.default.createDirectory(at: external, withIntermediateDirectories: false)
        XCTAssertThrowsError(try endpoint.addRoot(external))
        try FileManager.default.createSymbolicLink(at: documents.appendingPathComponent("external-link"), withDestinationURL: external)
        XCTAssertThrowsError(try endpoint.addRoot(documents.appendingPathComponent("external-link")))
        try endpoint.close()
        XCTAssertThrowsError(try endpoint.addRoot(documents))
        XCTAssertEqual(releases, 0)
    }

    func testReadOnlyDestinationPreservesFilesAndPermissions() throws {
        let readOnly = documents.appendingPathComponent("ReadOnly")
        try FileManager.default.createDirectory(at: readOnly, withIntermediateDirectories: false)
        try Data("original".utf8).write(to: readOnly.appendingPathComponent("keep.txt"))
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: readOnly.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: readOnly.path) }
        XCTAssertEqual(try endpoint.addRoot(readOnly)["path"] as? String, "/ReadOnly")
        let value = try call("begin", ["directory": "/ReadOnly", "name": "new.txt", "kind": "file", "conflict": "ask"])
        let id = try XCTUnwrap((value as? [String: Any])?["transferId"] as? String)
        try write(id, "cannot save")
        XCTAssertThrowsError(try call("commit", ["transferId": id]))
        _ = try call("abort", ["transferId": id])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: readOnly.path), ["keep.txt"])
        XCTAssertEqual(try String(contentsOf: readOnly.appendingPathComponent("keep.txt"), encoding: .utf8), "original")
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: readOnly.path)[.posixPermissions] as? NSNumber)?.intValue, 0o555)
    }

    func testUnreadableSelectionPreservesCurrentFolder() throws {
        let blocked = documents.appendingPathComponent("Blocked")
        try FileManager.default.createDirectory(at: blocked, withIntermediateDirectories: false)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: blocked.path) }
        try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: blocked.path)
        XCTAssertThrowsError(try endpoint.addRoot(blocked))
        var listing = try XCTUnwrap(call("list") as? [String: Any])
        XCTAssertEqual(listing["path"] as? String, "/Documents")
        XCTAssertEqual((listing["roots"] as? [[String: String]])?.map { $0["path"] }, ["/Documents"])
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: blocked.path)
        _ = try endpoint.addRoot(blocked)
        _ = try endpoint.addRoot(documents)
        try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: blocked.path)
        XCTAssertThrowsError(try endpoint.addRoot(blocked))
        listing = try XCTUnwrap(call("list") as? [String: Any])
        XCTAssertEqual(listing["path"] as? String, "/Documents")
        XCTAssertEqual((listing["roots"] as? [[String: String]])?.count, 2)
    }

    func testSecurityScopeReleaseAfterFailureDuplicateAndClose() throws {
        try endpoint.close()
        var releases = 0
        endpoint = try LocalFilesEndpoint(documents: documents, cache: folder, startAccess: { _ in true }, stopAccess: { _ in releases += 1 })
        let external = folder.appendingPathComponent("External")
        try FileManager.default.createDirectory(at: external, withIntermediateDirectories: false)
        _ = try endpoint.addRoot(external)
        XCTAssertEqual(releases, 0)
        _ = try endpoint.addRoot(external)
        XCTAssertEqual(releases, 1)
        let file = external.appendingPathComponent("file.txt")
        try Data().write(to: file)
        XCTAssertThrowsError(try endpoint.addRoot(file))
        XCTAssertEqual(releases, 2)
        let denied = folder.appendingPathComponent("Denied")
        try FileManager.default.createDirectory(at: denied, withIntermediateDirectories: false)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: denied.path) }
        try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: denied.path)
        XCTAssertThrowsError(try endpoint.addRoot(denied))
        XCTAssertEqual(releases, 3)
        XCTAssertEqual((try call("list") as? [String: Any])?["path"] as? String, "/External")
        try endpoint.close()
        XCTAssertEqual(releases, 4)
    }
}
