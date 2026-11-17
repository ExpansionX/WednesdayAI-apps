import Foundation
import Testing
@testable import OpenClaw

/// Replays a scripted list of `sessions.export` pages and records what the exporter asked for.
/// `sessions.export` pages are opaque JSON objects, so pages are supplied as plain dictionaries
/// and serialized on demand, exactly like the gateway payloads the real call returns.
@MainActor
private final class ExportPageStub {
    struct Call {
        let method: String
        let cursor: String?
        let timeoutMs: Double
    }

    private var pages: [[String: Any]]
    private(set) var calls: [Call] = []

    init(pages: [[String: Any]]) {
        self.pages = pages
    }

    func request(method: String, params: [String: AnyHashable], timeoutMs: Double) throws -> Data {
        self.calls.append(
            Call(method: method, cursor: params["cursor"]?.base as? String, timeoutMs: timeoutMs))
        guard !self.pages.isEmpty else {
            throw ControlChannelError.badResponse("stub exhausted")
        }
        return try JSONSerialization.data(withJSONObject: self.pages.removeFirst())
    }
}

@Suite(.serialized)
@MainActor
struct SessionActionsExportTests {
    /// Isolates each test into a unique fixture directory that the exporter writes into,
    /// so no test touches the process temporary directory shared with the running app.
    private func withTempExportDir(
        _ body: @MainActor (URL) async throws -> Void) async throws
    {
        let dir = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-session-export-fixture-\(UUID().uuidString)", isDirectory: true)
        try FileManager().createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager().removeItem(at: dir) }
        try await body(dir)
    }

    private func jsonlFiles(in dir: URL) -> [String] {
        ((try? FileManager().contentsOfDirectory(atPath: dir.path)) ?? [])
            .filter { $0.hasSuffix(".jsonl") }
    }

    @Test
    func `export pages through every cursor and writes each line once in order with mode 0600`() async throws {
        try await self.withTempExportDir { dir in
            let stub = ExportPageStub(pages: [
                ["sessionId": "s-1", "lines": ["l1", "l2"], "nextCursor": "c1"],
                ["sessionId": "s-1", "lines": ["l3"], "nextCursor": "c2"],
                ["sessionId": "s-1", "lines": ["l4", "l5"]],
            ])

            let url = try await SessionActions.exportSessionLogToJSONL(
                sessionKey: "main",
                fallbackSessionId: "fallback",
                inDirectory: dir,
                request: { method, params, timeoutMs in
                    try stub.request(method: method, params: params, timeoutMs: timeoutMs)
                })

            #expect(url == dir.appendingPathComponent("openclaw-session-s-1.jsonl"))
            let contents = try String(contentsOf: url, encoding: .utf8)
            #expect(contents == "l1\nl2\nl3\nl4\nl5\n")

            let attrs = try FileManager().attributesOfItem(atPath: url.path)
            let permissions = (attrs[.posixPermissions] as? NSNumber)?.intValue ?? -1
            #expect(permissions & 0o777 == 0o600)

            #expect(stub.calls.map(\.cursor) == [nil, "c1", "c2"])
            #expect(stub.calls.allSatisfy { $0.method == "sessions.export" })
            #expect(stub.calls.allSatisfy { $0.timeoutMs == 120_000 })
        }
    }

    @Test
    func `export throws on an immediately repeated cursor`() async throws {
        try await self.withTempExportDir { dir in
            let stub = ExportPageStub(pages: [
                ["sessionId": "s-1", "lines": ["l1"], "nextCursor": "c1"],
                ["sessionId": "s-1", "lines": ["l2"], "nextCursor": "c1"],
            ])

            do {
                _ = try await SessionActions.exportSessionLogToJSONL(
                    sessionKey: "main",
                    fallbackSessionId: "fallback",
                    inDirectory: dir,
                    request: { method, params, timeoutMs in
                        try stub.request(method: method, params: params, timeoutMs: timeoutMs)
                    })
                Issue.record("expected a repeated-cursor throw")
            } catch let error as ControlChannelError {
                #expect(error.errorDescription?.contains("repeated cursor") == true)
            }

            #expect(self.jsonlFiles(in: dir).isEmpty)
        }
    }

    @Test
    func `export throws when a cursor cycles back`() async throws {
        try await self.withTempExportDir { dir in
            let stub = ExportPageStub(pages: [
                ["sessionId": "s-1", "lines": ["l1"], "nextCursor": "c1"],
                ["sessionId": "s-1", "lines": ["l2"], "nextCursor": "c2"],
                ["sessionId": "s-1", "lines": ["l3"], "nextCursor": "c1"],
            ])

            do {
                _ = try await SessionActions.exportSessionLogToJSONL(
                    sessionKey: "main",
                    fallbackSessionId: "fallback",
                    inDirectory: dir,
                    request: { method, params, timeoutMs in
                        try stub.request(method: method, params: params, timeoutMs: timeoutMs)
                    })
                Issue.record("expected a repeated-cursor throw")
            } catch let error as ControlChannelError {
                #expect(error.errorDescription?.contains("repeated cursor") == true)
            }

            // The cycling cursor must stop the export at the page that returned it,
            // not drive a fourth request.
            #expect(stub.calls.count == 3)
            #expect(self.jsonlFiles(in: dir).isEmpty)
        }
    }

    @Test
    func `export throws when the session rotates mid export`() async throws {
        try await self.withTempExportDir { dir in
            let stub = ExportPageStub(pages: [
                ["sessionId": "s-1", "lines": ["l1"], "nextCursor": "c1"],
                ["sessionId": "s-2", "lines": ["x"]],
            ])

            do {
                _ = try await SessionActions.exportSessionLogToJSONL(
                    sessionKey: "main",
                    fallbackSessionId: "fallback",
                    inDirectory: dir,
                    request: { method, params, timeoutMs in
                        try stub.request(method: method, params: params, timeoutMs: timeoutMs)
                    })
                Issue.record("expected a session-rotation throw")
            } catch let error as ControlChannelError {
                #expect(error.errorDescription?.contains("switched sessions mid-export") == true)
            }

            #expect(self.jsonlFiles(in: dir).isEmpty)
        }
    }

    @Test
    func `export names the file from the fallback id when the gateway omits sessionId`() async throws {
        try await self.withTempExportDir { dir in
            let stub = ExportPageStub(pages: [["lines": ["a"]]])

            let url = try await SessionActions.exportSessionLogToJSONL(
                sessionKey: "main",
                fallbackSessionId: "fallback",
                inDirectory: dir,
                request: { method, params, timeoutMs in
                    try stub.request(method: method, params: params, timeoutMs: timeoutMs)
                })

            #expect(url.lastPathComponent == "openclaw-session-fallback.jsonl")
            let contents = try String(contentsOf: url, encoding: .utf8)
            #expect(contents == "a\n")
        }
    }
}
