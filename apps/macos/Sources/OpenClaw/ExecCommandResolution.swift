import Foundation

struct ExecCommandResolution: Sendable {
    let rawExecutable: String
    let resolvedPath: String?
    let executableName: String
    let cwd: String?
    var effectiveArgv: [String]?
    var wrapperChain: [String]?
    var policyBlocked: Bool
    var blockedWrapper: String?

    init(
        rawExecutable: String,
        resolvedPath: String?,
        executableName: String,
        cwd: String?,
        effectiveArgv: [String]? = nil,
        wrapperChain: [String]? = nil,
        policyBlocked: Bool = false,
        blockedWrapper: String? = nil)
    {
        self.rawExecutable = rawExecutable
        self.resolvedPath = resolvedPath
        self.executableName = executableName
        self.cwd = cwd
        self.effectiveArgv = effectiveArgv
        self.wrapperChain = wrapperChain
        self.policyBlocked = policyBlocked
        self.blockedWrapper = blockedWrapper
    }

    /// Mirror of core `resolveCommandResolutionFromArgv`: dispatch wrapper plans are
    /// resolved first and `rawExecutable` is the first token of the plan's effective
    /// argv. Env-modifier preludes, sudo-style dispatch wrappers and depth overflow
    /// yield `policyBlocked` resolutions that keep the outermost wrapper as
    /// `rawExecutable` — those can never be auto-approved by the allowlist.
    static func resolve(command: [String], cwd: String?, env: [String: String]?) -> ExecCommandResolution? {
        let plan = ExecDispatchWrapper.resolveDispatchWrapperExecutionPlan(command)
        guard let raw = plan.argv.first?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
            return nil
        }
        let resolution = self.resolveExecutable(rawExecutable: raw, cwd: cwd, env: env)
        return ExecCommandResolution(
            rawExecutable: resolution.rawExecutable,
            resolvedPath: resolution.resolvedPath,
            executableName: resolution.executableName,
            cwd: resolution.cwd,
            effectiveArgv: plan.argv,
            wrapperChain: plan.wrappers,
            policyBlocked: plan.policyBlocked,
            blockedWrapper: plan.blockedWrapper)
    }

    static func resolveForAllowlist(
        command: [String],
        rawCommand: String?,
        cwd: String?,
        env: [String: String]?) -> [ExecCommandResolution]
    {
        let shell = ExecShellWrapperParser.extract(command: command, rawCommand: rawCommand)
        if shell.isWrapper {
            guard let shellCommand = shell.command,
                  let segments = self.splitShellCommandChain(shellCommand)
            else {
                // Fail closed: if we cannot safely parse a shell wrapper payload,
                // treat this as an allowlist miss and require approval.
                return []
            }
            var resolutions: [ExecCommandResolution] = []
            resolutions.reserveCapacity(segments.count)
            for segment in segments {
                guard let segmentArgv = ExecShellArgvTokenizer.split(segment), !segmentArgv.isEmpty,
                      let resolution = self.resolve(command: segmentArgv, cwd: cwd, env: env),
                      !resolution.policyBlocked
                else {
                    // Fail closed on unparsable or policy-blocked segments.
                    return []
                }
                resolutions.append(resolution)
            }
            return resolutions
        }

        guard let resolution = self.resolve(command: command, cwd: cwd, env: env), !resolution.policyBlocked else {
            // Policy-blocked dispatch wrappers (env modifiers, sudo-style dispatch,
            // wrapper-depth overflow) can never satisfy the allowlist; execution
            // still requires an explicit ask decision.
            return []
        }
        return [resolution]
    }

    /// Mirror of core `resolveExecutablePath` + `buildCommandResolution`.
    private static func resolveExecutable(
        rawExecutable: String,
        cwd: String?,
        env: [String: String]?) -> ExecCommandResolution
    {
        let expanded = rawExecutable.hasPrefix("~") ? (rawExecutable as NSString).expandingTildeInPath : rawExecutable
        let resolvedPath = self.resolveExecutablePath(expanded, cwd: cwd, env: env)
        let name = resolvedPath.map { URL(fileURLWithPath: $0).lastPathComponent } ?? rawExecutable
        return ExecCommandResolution(
            rawExecutable: rawExecutable,
            resolvedPath: resolvedPath,
            executableName: name,
            cwd: cwd)
    }

    private static func isExecutableFile(_ path: String) -> Bool {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory), !isDirectory.boolValue else {
            return false
        }
        return FileManager.default.isExecutableFile(atPath: path)
    }

    private static func resolveExecutablePath(
        _ expanded: String,
        cwd: String?,
        env: [String: String]?) -> String?
    {
        if expanded.contains("/") || expanded.contains("\\") {
            if expanded.hasPrefix("/") {
                return self.isExecutableFile(expanded) ? expanded : nil
            }
            let base = cwd?.trimmingCharacters(in: .whitespacesAndNewlines)
            let root = (base?.isEmpty == false) ? base! : FileManager.default.currentDirectoryPath
            let candidate = URL(fileURLWithPath: root).appendingPathComponent(expanded).path
            return self.isExecutableFile(candidate) ? candidate : nil
        }
        let processEnv = ProcessInfo.processInfo.environment
        let pathEnv = env?["PATH"] ?? env?["Path"] ?? processEnv["PATH"] ?? processEnv["Path"] ?? ""
        return self.resolveExecutableFromPathEnv(expanded, pathEnv: pathEnv)
    }

    private static func resolveExecutableFromPathEnv(_ executable: String, pathEnv: String) -> String? {
        for entry in pathEnv.split(separator: ":", omittingEmptySubsequences: true) {
            let candidate = URL(fileURLWithPath: String(entry)).appendingPathComponent(executable).path
            if self.isExecutableFile(candidate) {
                return candidate
            }
        }
        return nil
    }

    private enum ShellTokenContext {
        case unquoted
        case doubleQuoted
    }

    private struct ShellFailClosedRule {
        let token: Character
        let next: Character?
    }

    private static let shellFailClosedRules: [ShellTokenContext: [ShellFailClosedRule]] = [
        .unquoted: [
            ShellFailClosedRule(token: "`", next: nil),
            ShellFailClosedRule(token: "$", next: "("),
            ShellFailClosedRule(token: "<", next: "("),
            ShellFailClosedRule(token: ">", next: "("),
        ],
        .doubleQuoted: [
            ShellFailClosedRule(token: "`", next: nil),
            ShellFailClosedRule(token: "$", next: "("),
        ],
    ]

    private static func splitShellCommandChain(_ command: String) -> [String]? {
        let trimmed = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        var segments: [String] = []
        var current = ""
        var inSingle = false
        var inDouble = false
        var escaped = false
        let chars = Array(trimmed)
        var idx = 0

        func appendCurrent() -> Bool {
            let segment = current.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !segment.isEmpty else { return false }
            segments.append(segment)
            current.removeAll(keepingCapacity: true)
            return true
        }

        while idx < chars.count {
            let ch = chars[idx]
            let next: Character? = idx + 1 < chars.count ? chars[idx + 1] : nil

            if escaped {
                current.append(ch)
                escaped = false
                idx += 1
                continue
            }

            if ch == "\\", !inSingle {
                current.append(ch)
                escaped = true
                idx += 1
                continue
            }

            if ch == "'", !inDouble {
                inSingle.toggle()
                current.append(ch)
                idx += 1
                continue
            }

            if ch == "\"", !inSingle {
                inDouble.toggle()
                current.append(ch)
                idx += 1
                continue
            }

            if !inSingle, self.shouldFailClosedForShell(ch: ch, next: next, inDouble: inDouble) {
                // Fail closed on command/process substitution in allowlist mode,
                // including command substitution inside double-quoted shell strings.
                return nil
            }

            if !inSingle, !inDouble {
                let prev: Character? = idx > 0 ? chars[idx - 1] : nil
                if let delimiterStep = self.chainDelimiterStep(ch: ch, prev: prev, next: next) {
                    guard appendCurrent() else { return nil }
                    idx += delimiterStep
                    continue
                }
            }

            current.append(ch)
            idx += 1
        }

        if escaped || inSingle || inDouble { return nil }
        guard appendCurrent() else { return nil }
        return segments
    }

    private static func shouldFailClosedForShell(ch: Character, next: Character?, inDouble: Bool) -> Bool {
        let context: ShellTokenContext = inDouble ? .doubleQuoted : .unquoted
        guard let rules = self.shellFailClosedRules[context] else {
            return false
        }
        for rule in rules {
            if ch == rule.token, rule.next == nil || next == rule.next {
                return true
            }
        }
        return false
    }

    private static func chainDelimiterStep(ch: Character, prev: Character?, next: Character?) -> Int? {
        if ch == ";" || ch == "\n" {
            return 1
        }
        if ch == "&" {
            if next == "&" {
                return 2
            }
            // Keep fd redirections like 2>&1 or &>file intact.
            let prevIsRedirect = prev == ">"
            let nextIsRedirect = next == ">"
            return (!prevIsRedirect && !nextIsRedirect) ? 1 : nil
        }
        if ch == "|" {
            if next == "|" || next == "&" {
                return 2
            }
            return 1
        }
        return nil
    }
}

enum ExecCommandFormatter {
    /// Mirror of core `formatExecCommand` (src/infra/system-run-command.ts).
    static func displayString(for argv: [String]) -> String {
        argv.map { arg in
            if arg.isEmpty { return "\"\"" }
            let needsQuotes = arg.contains { $0.isWhitespace || $0 == "\"" }
            if !needsQuotes { return arg }
            let escaped = arg.replacingOccurrences(of: "\"", with: "\\\"")
            return "\"\(escaped)\""
        }.joined(separator: " ")
    }

    static func displayString(for argv: [String], rawCommand: String?) -> String {
        let trimmed = rawCommand?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmed.isEmpty { return trimmed }
        return self.displayString(for: argv)
    }
}
