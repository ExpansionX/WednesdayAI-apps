import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct ExecApprovalsStoreRefactorTests {
    /// Isolates each test from parallel tests that resolve the store through the
    /// process-global OPENCLAW_STATE_DIR: the env points at a throwaway dir that
    /// absorbs foreign writers, while the store calls below pin an explicit
    /// fixture directory that no other test can touch.
    private func withTempStateDir(
        _ body: @escaping @Sendable (URL) async throws -> Void) async throws
    {
        let envDir = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-state-env-\(UUID().uuidString)", isDirectory: true)
        let fixtureDir = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-state-fixture-\(UUID().uuidString)", isDirectory: true)
        defer {
            try? FileManager().removeItem(at: envDir)
            try? FileManager().removeItem(at: fixtureDir)
        }

        try await TestIsolation.withEnvValues(["OPENCLAW_STATE_DIR": envDir.path]) {
            try await body(fixtureDir)
        }
    }

    @Test
    func `ensure file skips rewrite when unchanged`() async throws {
        try await self.withTempStateDir { stateDir in
            _ = ExecApprovalsStore.ensureFile(inDirectory: stateDir.path)
            let url = ExecApprovalsStore.fileURL(inDirectory: stateDir.path)
            // Stamp a known past mtime so a rewrite is detectable regardless of
            // filesystem timestamp granularity: a rewrite would move mtime to
            // ~now, which can never equal the stamped date.
            let knownPast = Date(timeIntervalSinceNow: -3600)
            try FileManager.default.setAttributes(
                [.modificationDate: knownPast],
                ofItemAtPath: url.path)
            let stampedDate = try Self.modificationDate(at: url)
            let original = try String(contentsOf: url, encoding: .utf8)

            _ = ExecApprovalsStore.ensureFile(inDirectory: stateDir.path)

            let writeDate = try Self.modificationDate(at: url)
            #expect(writeDate == stampedDate)
            let current = try String(contentsOf: url, encoding: .utf8)
            #expect(current == original)
        }
    }

    @Test
    func `update allowlist reports rejected basename pattern`() async throws {
        try await self.withTempStateDir { stateDir in
            let rejected = ExecApprovalsStore.updateAllowlist(
                agentId: "main",
                allowlist: [
                    ExecAllowlistEntry(pattern: "echo"),
                    ExecAllowlistEntry(pattern: "/bin/echo"),
                ],
                inDirectory: stateDir.path)
            #expect(rejected.count == 1)
            #expect(rejected.first?.reason == .missingPathComponent)
            #expect(rejected.first?.pattern == "echo")

            let resolved = ExecApprovalsStore.resolve(agentId: "main", inDirectory: stateDir.path)
            #expect(resolved.allowlist.map(\.pattern) == ["/bin/echo"])
            // Review S1: the resolved metadata must name the requested fixture
            // file, not the process-global state dir.
            #expect(resolved.url == ExecApprovalsStore.fileURL(inDirectory: stateDir.path))
        }
    }

    @Test
    func `update allowlist migrates legacy pattern from resolved path`() async throws {
        try await self.withTempStateDir { stateDir in
            let rejected = ExecApprovalsStore.updateAllowlist(
                agentId: "main",
                allowlist: [
                    ExecAllowlistEntry(
                        pattern: "echo",
                        lastUsedAt: nil,
                        lastUsedCommand: nil,
                        lastResolvedPath: " /usr/bin/echo "),
                ],
                inDirectory: stateDir.path)
            #expect(rejected.isEmpty)

            let resolved = ExecApprovalsStore.resolve(agentId: "main", inDirectory: stateDir.path)
            #expect(resolved.allowlist.map(\.pattern) == ["/usr/bin/echo"])
        }
    }

    @Test
    func `ensure file hardens state directory permissions`() async throws {
        try await self.withTempStateDir { stateDir in
            try FileManager().createDirectory(at: stateDir, withIntermediateDirectories: true)
            try FileManager().setAttributes([.posixPermissions: 0o755], ofItemAtPath: stateDir.path)

            _ = ExecApprovalsStore.ensureFile(inDirectory: stateDir.path)
            let attrs = try FileManager().attributesOfItem(atPath: stateDir.path)
            let permissions = (attrs[.posixPermissions] as? NSNumber)?.intValue ?? -1
            #expect(permissions & 0o777 == 0o700)
        }
    }

    private static func modificationDate(at url: URL) throws -> Date {
        let attributes = try FileManager().attributesOfItem(atPath: url.path)
        guard let date = attributes[.modificationDate] as? Date else {
            struct MissingDateError: Error {}
            throw MissingDateError()
        }
        return date
    }
}
