import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct OpenClawConfigFileTests {
    private func makeConfigOverridePath() -> String {
        FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-config-\(UUID().uuidString)")
            .appendingPathComponent("openclaw.json")
            .path
    }

    @Test
    func `config path respects env override`() async {
        let override = self.makeConfigOverridePath()

        await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": override]) {
            #expect(OpenClawConfigFile.url().path == override)
        }
    }

    @MainActor
    @Test
    func `remote gateway port parses and matches host`() async {
        let override = self.makeConfigOverridePath()

        await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": override]) {
            OpenClawConfigFile.saveDict([
                "gateway": [
                    "remote": [
                        "url": "ws://gateway.ts.net:19999",
                    ],
                ],
            ])
            #expect(OpenClawConfigFile.remoteGatewayPort() == 19999)
            #expect(OpenClawConfigFile.remoteGatewayPort(matchingHost: "gateway.ts.net") == 19999)
            #expect(OpenClawConfigFile.remoteGatewayPort(matchingHost: "gateway") == 19999)
            #expect(OpenClawConfigFile.remoteGatewayPort(matchingHost: "other.ts.net") == nil)
        }
    }

    @MainActor
    @Test
    func `set remote gateway url preserves scheme`() async {
        let override = self.makeConfigOverridePath()

        await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": override]) {
            OpenClawConfigFile.saveDict([
                "gateway": [
                    "remote": [
                        "url": "wss://old-host:111",
                    ],
                ],
            ])
            OpenClawConfigFile.setRemoteGatewayUrl(host: "new-host", port: 2222)
            let root = OpenClawConfigFile.loadDict()
            let url = ((root["gateway"] as? [String: Any])?["remote"] as? [String: Any])?["url"] as? String
            #expect(url == "wss://new-host:2222")
        }
    }

    @MainActor
    @Test
    func `clear remote gateway url removes only url field`() async {
        let override = self.makeConfigOverridePath()

        await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": override]) {
            OpenClawConfigFile.saveDict([
                "gateway": [
                    "remote": [
                        "url": "wss://old-host:111",
                        "token": "tok",
                    ],
                ],
            ])
            OpenClawConfigFile.clearRemoteGatewayUrl()
            let root = OpenClawConfigFile.loadDict()
            let remote = ((root["gateway"] as? [String: Any])?["remote"] as? [String: Any]) ?? [:]
            #expect((remote["url"] as? String) == nil)
            #expect((remote["token"] as? String) == "tok")
        }
    }

    @Test
    func `state dir override sets config path`() async {
        let dir = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-state-\(UUID().uuidString)", isDirectory: true)
            .path

        await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": nil,
            "OPENCLAW_STATE_DIR": dir,
        ]) {
            #expect(OpenClawConfigFile.stateDirURL().path == dir)
            #expect(OpenClawConfigFile.url().path == "\(dir)/openclaw.json")
        }
    }

    @Test
    func `explicit nil env override masks an outer override`() async {
        // Review S2: an inner `withEnvValues(["OPENCLAW_CONFIG_PATH": nil])`
        // must mask the key (unset semantics) instead of deleting the override
        // and revealing the outer level's value.
        let outerOverride = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-outer-\(UUID().uuidString)")
            .appendingPathComponent("openclaw.json")
            .path
        let stateDir = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-state-\(UUID().uuidString)", isDirectory: true)
            .path

        await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": outerOverride]) {
            #expect(OpenClawConfigFile.url().path == outerOverride)

            await TestIsolation.withEnvValues([
                "OPENCLAW_CONFIG_PATH": nil,
                "OPENCLAW_STATE_DIR": stateDir,
            ]) {
                // Masked: the outer override is not visible and the state-dir
                // fixture path wins. The mask is ENCODED (empty override), not
                // deleted, so the outer value cannot leak through the live
                // environment fallback.
                #expect(OpenClawEnv.overrideValue(forKey: "OPENCLAW_CONFIG_PATH") == "")
                #expect(OpenClawConfigFile.url().path == "\(stateDir)/openclaw.json")
            }

            // The outer override is restored after the inner scope ends.
            #expect(OpenClawConfigFile.url().path == outerOverride)
        }
    }

    @Test
    func `concurrent isolation scopes serialize on the same key`() async {
        // Review S3: two unrelated concurrent scopes on the same key must
        // serialize (the second acquires the lock only after the first
        // restores), each observing only its own value, and the live
        // resolution must return to its original state afterwards.
        // Baseline and final snapshots are their own root lock scopes: another
        // suite's legitimate override scope may hold the lock concurrently, so
        // reading live resolution outside serialization would be flaky.
        let original = await TestIsolation.withLock { OpenClawConfigFile.url().path }
        let first = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-concurrent-a-\(UUID().uuidString)")
            .appendingPathComponent("openclaw.json")
            .path
        let second = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-concurrent-b-\(UUID().uuidString)")
            .appendingPathComponent("openclaw.json")
            .path

        // The sleep inside each scope widens the overlap window: a global
        // depth counter (or no lock at all) would let the second scope's
        // override clobber the first's read mid-flight.
        async let firstObserved = Self.configPathWhileOverridden(path: first)
        async let secondObserved = Self.configPathWhileOverridden(path: second)
        let observed = await [firstObserved, secondObserved]

        #expect(observed == [first, second])
        let final = await TestIsolation.withLock { OpenClawConfigFile.url().path }
        #expect(final == original)
    }

    private static func configPathWhileOverridden(path: String) async -> String? {
        await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": path]) {
            try? await Task.sleep(for: .milliseconds(50))
            return OpenClawConfigFile.url().path
        }
    }

    @MainActor
    @Test
    func `save dict appends config audit log`() async throws {
        let stateDir = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-state-\(UUID().uuidString)", isDirectory: true)
        let configPath = stateDir.appendingPathComponent("openclaw.json")
        let auditPath = stateDir.appendingPathComponent("logs/config-audit.jsonl")

        defer { try? FileManager().removeItem(at: stateDir) }

        try await TestIsolation.withEnvValues([
            "OPENCLAW_STATE_DIR": stateDir.path,
            "OPENCLAW_CONFIG_PATH": configPath.path,
        ]) {
            OpenClawConfigFile.saveDict([
                "gateway": ["mode": "local"],
            ])

            let configData = try Data(contentsOf: configPath)
            let configRoot = try JSONSerialization.jsonObject(with: configData) as? [String: Any]
            #expect((configRoot?["meta"] as? [String: Any]) != nil)

            let rawAudit = try String(contentsOf: auditPath, encoding: .utf8)
            let lines = rawAudit
                .split(whereSeparator: \.isNewline)
                .map(String.init)
            #expect(!lines.isEmpty)
            guard let last = lines.last else {
                Issue.record("Missing config audit line")
                return
            }
            let auditRoot = try JSONSerialization.jsonObject(with: Data(last.utf8)) as? [String: Any]
            #expect(auditRoot?["source"] as? String == "macos-openclaw-config-file")
            #expect(auditRoot?["event"] as? String == "config.write")
            #expect(auditRoot?["result"] as? String == "success")
            #expect(auditRoot?["configPath"] as? String == configPath.path)
        }
    }
}
