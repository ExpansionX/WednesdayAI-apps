import Foundation

enum OpenClawEnv {
    private final class OverrideStore: @unchecked Sendable {
        let lock = NSLock()
        var values: [String: String] = [:]
    }

    private static let overrideStore = OverrideStore()

    /// Injectable overrides consulted before the live environment. Tests set
    /// these through `TestIsolation` instead of mutating the process-global
    /// environment, which Foundation may snapshot at first access — a mid-run
    /// `setenv` is then invisible to later reads (Apple CI failure on 89ad0ed6).
    static func overrideValue(forKey key: String) -> String? {
        self.overrideStore.lock.lock()
        defer { self.overrideStore.lock.unlock() }
        return self.overrideStore.values[key]
    }

    static func setOverrideValue(_ value: String?, forKey key: String) {
        self.overrideStore.lock.lock()
        defer { self.overrideStore.lock.unlock() }
        if let value {
            self.overrideStore.values[key] = value
        } else {
            self.overrideStore.values.removeValue(forKey: key)
        }
    }

    static func path(_ key: String) -> String? {
        let raw: String? = if let override = Self.overrideValue(forKey: key) {
            override
        } else {
            getenv(key).map { String(cString: $0) }
        }
        // Normalize env overrides once so UI + file IO stay consistent.
        let value = raw?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let value, !value.isEmpty
        else {
            return nil
        }
        return value
    }
}

enum OpenClawPaths {
    private static let configPathEnv = ["OPENCLAW_CONFIG_PATH"]
    private static let stateDirEnv = ["OPENCLAW_STATE_DIR"]

    static var stateDirURL: URL {
        for key in self.stateDirEnv {
            if let override = OpenClawEnv.path(key) {
                return URL(fileURLWithPath: override, isDirectory: true)
            }
        }
        let home = FileManager().homeDirectoryForCurrentUser
        return home.appendingPathComponent(".openclaw", isDirectory: true)
    }

    private static func resolveConfigCandidate(in dir: URL) -> URL? {
        let candidates = [
            dir.appendingPathComponent("openclaw.json"),
        ]
        return candidates.first(where: { FileManager().fileExists(atPath: $0.path) })
    }

    static var configURL: URL {
        for key in self.configPathEnv {
            if let override = OpenClawEnv.path(key) {
                return URL(fileURLWithPath: override)
            }
        }
        let stateDir = self.stateDirURL
        if let existing = self.resolveConfigCandidate(in: stateDir) {
            return existing
        }
        return stateDir.appendingPathComponent("openclaw.json")
    }

    static var workspaceURL: URL {
        self.stateDirURL.appendingPathComponent("workspace", isDirectory: true)
    }
}
