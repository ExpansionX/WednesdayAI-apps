import Foundation
import Testing
@testable import OpenClaw

struct GatewayLaunchAgentManagerTests {
    @Test func `launch agent plist snapshot parses args and env`() throws {
        let url = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-launchd-\(UUID().uuidString).plist")
        let plist: [String: Any] = [
            "ProgramArguments": ["openclaw", "gateway-daemon", "--port", "18789", "--bind", "loopback"],
            "EnvironmentVariables": [
                "OPENCLAW_GATEWAY_TOKEN": " secret ",
                "OPENCLAW_GATEWAY_PASSWORD": "pw",
            ],
        ]
        let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        try data.write(to: url, options: [.atomic])
        defer { try? FileManager().removeItem(at: url) }

        let snapshot = try #require(LaunchAgentPlist.snapshot(url: url))
        #expect(snapshot.port == 18789)
        #expect(snapshot.bind == "loopback")
        #expect(snapshot.token == "secret")
        #expect(snapshot.password == "pw")
    }

    @Test func `launch agent plist snapshot allows missing bind`() throws {
        let url = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-launchd-\(UUID().uuidString).plist")
        let plist: [String: Any] = [
            "ProgramArguments": ["openclaw", "gateway-daemon", "--port", "18789"],
        ]
        let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        try data.write(to: url, options: [.atomic])
        defer { try? FileManager().removeItem(at: url) }

        let snapshot = try #require(LaunchAgentPlist.snapshot(url: url))
        #expect(snapshot.port == 18789)
        #expect(snapshot.bind == nil)
    }

    private func makeLaunchAgentsDir() throws -> URL {
        let dir = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-la-\(UUID().uuidString)")
        try FileManager().createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func writePlist(dir: URL, label: String, stdout: String) throws {
        let plist: [String: Any] = [
            "ProgramArguments": ["openclaw", "gateway-daemon", "--port", "18789"],
            "StandardOutPath": stdout,
        ]
        let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        try data.write(to: dir.appendingPathComponent("\(label).plist"), options: [.atomic])
    }

    @Test func `snapshot reads new label plist`() throws {
        let dir = try self.makeLaunchAgentsDir()
        defer { try? FileManager().removeItem(at: dir) }
        try self.writePlist(dir: dir, label: "ai.wednesdayai.gateway", stdout: "/new.log")

        let snapshot = try #require(GatewayLaunchAgentManager.launchdConfigSnapshot(launchAgentsDir: dir))
        #expect(snapshot.stdoutPath == "/new.log")
    }

    @Test func `snapshot falls back to legacy label plist`() throws {
        let dir = try self.makeLaunchAgentsDir()
        defer { try? FileManager().removeItem(at: dir) }
        try self.writePlist(dir: dir, label: "ai.openclaw.gateway", stdout: "/legacy.log")

        let snapshot = try #require(GatewayLaunchAgentManager.launchdConfigSnapshot(launchAgentsDir: dir))
        #expect(snapshot.stdoutPath == "/legacy.log")
    }

    @Test func `snapshot prefers new label when both exist`() throws {
        let dir = try self.makeLaunchAgentsDir()
        defer { try? FileManager().removeItem(at: dir) }
        try self.writePlist(dir: dir, label: "ai.wednesdayai.gateway", stdout: "/new.log")
        try self.writePlist(dir: dir, label: "ai.openclaw.gateway", stdout: "/legacy.log")

        let snapshot = try #require(GatewayLaunchAgentManager.launchdConfigSnapshot(launchAgentsDir: dir))
        #expect(snapshot.stdoutPath == "/new.log")
    }
}
