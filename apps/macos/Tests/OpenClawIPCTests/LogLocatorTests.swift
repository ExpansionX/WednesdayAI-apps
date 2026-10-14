import Foundation
import Testing
@testable import OpenClaw

struct LogLocatorTests {
    @Test func `launchd gateway log path ensures tmp dir exists`() {
        let fm = FileManager()
        let baseDir = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        let logDir = baseDir.appendingPathComponent("openclaw-tests-\(UUID().uuidString)")
        defer { try? fm.removeItem(at: logDir) }

        // Injected directly — no process-environment mutation.
        _ = LogLocator.launchdGatewayLogPath(logDirectory: logDir)

        var isDir: ObjCBool = false
        #expect(fm.fileExists(atPath: logDir.path, isDirectory: &isDir))
        #expect(isDir.boolValue == true)
    }
}
