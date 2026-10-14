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

        let outTask = Task { stdoutPipe.fileHandleForReading.readToEndSafely() }
        let errTask = Task { stderrPipe.fileHandleForReading.readToEndSafely() }

        let waitTask = Task { () -> ShellResult in
            process.waitUntilExit()
            let out = await outTask.value
            let err = await errTask.value
            let status = Int(process.terminationStatus)
            return ShellResult(
                stdout: String(bytes: out, encoding: .utf8) ?? "",
                stderr: String(bytes: err, encoding: .utf8) ?? "",
                exitCode: status,
                timedOut: false,
                success: status == 0,
                errorMessage: status == 0 ? nil : "exit \(status)")
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
