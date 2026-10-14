import Foundation
@testable import OpenClaw

actor TestIsolationLock {
    static let shared = TestIsolationLock()

    private var locked = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func acquire() async {
        if !self.locked {
            self.locked = true
            return
        }
        await withCheckedContinuation { cont in
            self.waiters.append(cont)
        }
        // `unlock()` resumed us; lock is now held for this caller.
    }

    func release() {
        if self.waiters.isEmpty {
            self.locked = false
            return
        }
        let next = self.waiters.removeFirst()
        next.resume()
    }
}

@MainActor
enum TestIsolation {
    static func withIsolatedState<T>(
        env: [String: String?] = [:],
        _ body: () async throws -> T) async rethrows -> T
    {
        await TestIsolationLock.shared.acquire()
        // Env isolation goes through the OpenClawEnv override seam, not the
        // process-global environment: Foundation may snapshot the environment
        // at first access, hiding mid-run setenv calls from later reads.
        var previousOverrides: [String: String?] = [:]
        for (key, value) in env {
            previousOverrides[key] = OpenClawEnv.overrideValue(forKey: key)
            OpenClawEnv.setOverrideValue(value, forKey: key)
        }

        do {
            let result = try await body()
            restoreOverrides(previousOverrides)
            await TestIsolationLock.shared.release()
            return result
        } catch {
            restoreOverrides(previousOverrides)
            await TestIsolationLock.shared.release()
            throw error
        }
    }

    private static func restoreOverrides(_ values: [String: String?]) {
        for (key, value) in values {
            OpenClawEnv.setOverrideValue(value, forKey: key)
        }
    }

    static func withEnvValues<T>(
        _ values: [String: String?],
        _ body: () async throws -> T) async rethrows -> T
    {
        try await self.withIsolatedState(env: values, body)
    }

    nonisolated static func tempConfigPath() -> String {
        FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-test-config-\(UUID().uuidString).json")
            .path
    }
}
