import Foundation
import OpenClawIPC

enum ShellExecutor {
    struct ShellResult {
        var stdout: String
        var stderr: String
        var exitCode: Int?
        var timedOut: Bool
        var success: Bool
        var errorMessage: String?
    }

    static func runDetailed(
        command: [String],
        cwd: String?,
        env: [String: String]?,
        timeout: Double?) async -> ShellResult
    {
        guard !command.isEmpty else {
            return ShellResult(
                stdout: "",
                stderr: "",
                exitCode: nil,
                timedOut: false,
                success: false,
                errorMessage: "empty command")
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = command
        if let cwd { process.currentDirectoryURL = URL(fileURLWithPath: cwd) }
        if let env { process.environment = env }

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        do {
            try process.run()
        } catch {
            return ShellResult(
                stdout: "",
                stderr: "",
                exitCode: nil,
                timedOut: false,
                success: false,
                errorMessage: "failed to start: \(error.localizedDescription)")
        }

        // waitUntilExit and the pipe drains block; run them on GCD so they cannot
        // starve the cooperative pool (a starved pool delayed the timeout task past
        // the child's natural exit on loaded CI runners). Drains must run concurrently
        // with the wait: a child that fills the pipe buffer never exits otherwise.
        let waitTask = Task { () -> ShellResult in
            await withCheckedContinuation { (continuation: CheckedContinuation<ShellResult, Never>) in
                let group = DispatchGroup()
                let outBox = DataBox()
                let errBox = DataBox()

                group.enter()
                DispatchQueue.global().async {
                    outBox.data = stdoutPipe.fileHandleForReading.readToEndSafely()
                    group.leave()
                }
                group.enter()
                DispatchQueue.global().async {
                    errBox.data = stderrPipe.fileHandleForReading.readToEndSafely()
                    group.leave()
                }
                group.enter()
                DispatchQueue.global().async {
                    process.waitUntilExit()
                    group.leave()
                }

                group.notify(queue: .global()) {
                    let status = Int(process.terminationStatus)
                    continuation.resume(returning: ShellResult(
                        stdout: String(bytes: outBox.data, encoding: .utf8) ?? "",
                        stderr: String(bytes: errBox.data, encoding: .utf8) ?? "",
                        exitCode: status,
                        timedOut: false,
                        success: status == 0,
                        errorMessage: status == 0 ? nil : "exit \(status)"))
                }
            }
        }

        if let timeout, timeout > 0 {
            let nanos = UInt64(timeout * 1_000_000_000)
            let state = TimeoutTracker()
            return await withTaskGroup(of: ShellResult.self) { group in
                group.addTask { await waitTask.value }
                group.addTask {
                    try? await Task.sleep(nanoseconds: nanos)
                    state.markFiredIfRunning(process)
                    _ = await waitTask.value // drain pipes after termination
                    return ShellResult(
                        stdout: "",
                        stderr: "",
                        exitCode: nil,
                        timedOut: true,
                        success: false,
                        errorMessage: "timeout")
                }
                let first = await group.next()!
                group.cancelAll()
                // The timeout branch always awaits waitTask, so completion order is
                // racy; the fired flag — not which result arrived first — decides.
                if state.didFire {
                    return ShellResult(
                        stdout: first.stdout,
                        stderr: first.stderr,
                        exitCode: first.exitCode,
                        timedOut: true,
                        success: false,
                        errorMessage: "timeout")
                }
                return first
            }
        }

        return await waitTask.value
    }

    static func run(command: [String], cwd: String?, env: [String: String]?, timeout: Double?) async -> Response {
        let result = await self.runDetailed(command: command, cwd: cwd, env: env, timeout: timeout)
        let combined = result.stdout.isEmpty ? result.stderr : result.stdout
        let payload = combined.isEmpty ? nil : Data(combined.utf8)
        return Response(ok: result.success, message: result.errorMessage, payload: payload)
    }
}

/// Thread-safe flag recording whether the timeout branch terminated the process.
private final class TimeoutTracker: @unchecked Sendable {
    private let lock = NSLock()
    private var fired = false

    func markFiredIfRunning(_ process: Process) {
        self.lock.lock()
        if process.isRunning {
            process.terminate()
            self.fired = true
        }
        self.lock.unlock()
    }

    var didFire: Bool {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.fired
    }
}

/// Thread-safe Data holder for concurrent GCD drain results.
private final class DataBox: @unchecked Sendable {
    private let lock = NSLock()
    private var storage = Data()

    var data: Data {
        get {
            self.lock.lock()
            defer { self.lock.unlock() }
            return self.storage
        }
        set {
            self.lock.lock()
            self.storage = newValue
            self.lock.unlock()
        }
    }
}
