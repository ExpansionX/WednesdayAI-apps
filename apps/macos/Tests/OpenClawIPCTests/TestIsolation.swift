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
    /// Bound while a scope holds `TestIsolationLock`. Only lexical children of
    /// the locked scope (nested `withEnvValues` calls in the same task) see it
    /// and skip re-acquiring; unrelated concurrent tests run in different
    /// tasks, never inherit the binding, and always acquire the lock — so
    /// scopes on the same key serialize instead of racing a global counter
    /// (review S3).
    @TaskLocal static var isHoldingIsolationLock = false

    static func withIsolatedState<T>(
        env: [String: String?] = [:],
        _ body: () async throws -> T) async rethrows -> T
    {
        if Self.isHoldingIsolationLock {
            // Lexical child of the locked scope: layer the overrides on top of
            // the outer scope's; restore pops them in order. The outer frame
            // owns the lock and releases it.
            return try await Self.runWithOverrides(env: env, body)
        }
        await TestIsolationLock.shared.acquire()
        do {
            let result = try await Self.$isHoldingIsolationLock.withValue(true) {
                try await Self.runWithOverrides(env: env, body)
            }
            await TestIsolationLock.shared.release()
            return result
        } catch {
            await TestIsolationLock.shared.release()
            throw error
        }
    }

    private static func runWithOverrides<T>(
        env: [String: String?],
        _ body: () async throws -> T) async rethrows -> T
    {
        // Env isolation goes through the OpenClawEnv override seam, not the
        // process-global environment: Foundation may snapshot the environment
        // at first access, hiding mid-run setenv calls from later reads.
        var previousOverrides: [String: String?] = [:]
        for (key, value) in env {
            previousOverrides[key] = OpenClawEnv.overrideValue(forKey: key)
            // An explicit nil masks the key for the body (unset semantics): it
            // must NOT reveal an outer override. Encoding the mask as the
            // empty string works because OpenClawEnv.path normalizes "" to
            // unset; `value ?? ""` therefore never deletes an outer override.
            OpenClawEnv.setOverrideValue(value ?? "", forKey: key)
        }

        do {
            let result = try await body()
            restoreOverrides(previousOverrides)
            return result
        } catch {
            restoreOverrides(previousOverrides)
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
