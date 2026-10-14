import Foundation

/// One analyzed command segment (mirror of core `ExecCommandSegment`): a raw
/// shell segment with its tokenized argv and dispatch-plan resolution. Policy
/// evaluation must treat a `policyBlocked` resolution as unsatisfiable while
/// still retaining the segment for prompt display and allow-always persistence.
struct ExecCommandSegment: Sendable {
    let raw: String
    let argv: [String]
    let resolution: ExecCommandResolution?
}

/// Mirror of core `analyzeArgvCommand`/`analyzeShellCommand` output for the
/// macOS exec host: ok=false means the command could not be analyzed safely
/// (fail closed). `shellCommand` is the extracted shell payload when the argv
/// is a recognized shell wrapper — extraction deliberately ignores rawCommand,
/// which is display text only.
struct ExecCommandAnalysis: Sendable {
    let ok: Bool
    let shellCommand: String?
    let segments: [ExecCommandSegment]
}

struct ExecCommandResolution: Sendable {
    let rawExecutable: String
    let resolvedPath: String?
    let resolvedRealPath: String?
    let executableName: String
    let cwd: String?
    var effectiveArgv: [String]?
    var wrapperChain: [String]?
    var policyBlocked: Bool
    var blockedWrapper: String?

    init(
        rawExecutable: String,
        resolvedPath: String?,
        resolvedRealPath: String? = nil,
        executableName: String,
        cwd: String?,
        effectiveArgv: [String]? = nil,
        wrapperChain: [String]? = nil,
        policyBlocked: Bool = false,
        blockedWrapper: String? = nil)
    {
        self.rawExecutable = rawExecutable
        self.resolvedPath = resolvedPath
        self.resolvedRealPath = resolvedRealPath
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
            resolvedRealPath: resolution.resolvedRealPath,
            executableName: resolution.executableName,
            cwd: resolution.cwd,
            effectiveArgv: plan.argv,
            wrapperChain: plan.wrappers,
            policyBlocked: plan.policyBlocked,
            blockedWrapper: plan.blockedWrapper)
    }

    /// Mirror of core `analyzeShellCommand`/`evaluateShellAllowlist` for the
    /// macOS host: when the argv is a recognized shell wrapper, the payload is
    /// chain-split and each segment is tokenized and resolved through its own
    /// dispatch plan. Segments with `policyBlocked` resolutions are retained
    /// (unsatisfiable) so allow-always persistence can still derive the inner
    /// executables, mirroring core segment retention.
    static func analyze(
        command: [String],
        rawCommand: String?,
        cwd: String?,
        env: [String: String]?) -> ExecCommandAnalysis
    {
        // rawCommand is display text only; analysis is argv-based (core parity).
        let shell = ExecShellWrapperParser.extract(command: command, rawCommand: nil)
        if shell.isWrapper {
            guard let shellCommand = shell.command else {
                return ExecCommandAnalysis(ok: false, shellCommand: nil, segments: [])
            }
            let analysis = self.analyzeShellCommand(shellCommand, cwd: cwd, env: env)
            return ExecCommandAnalysis(ok: analysis.ok, shellCommand: shellCommand, segments: analysis.segments)
        }
        return self.analyzeArgv(command: command, cwd: cwd, env: env)
    }

    static func analyzeArgv(command: [String], cwd: String?, env: [String: String]?) -> ExecCommandAnalysis {
        let filtered = command.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        guard !filtered.isEmpty else {
            return ExecCommandAnalysis(ok: false, shellCommand: nil, segments: [])
        }
        let resolution = self.resolve(command: filtered, cwd: cwd, env: env)
        let segment = ExecCommandSegment(
            raw: filtered.joined(separator: " "),
            argv: filtered,
            resolution: resolution)
        return ExecCommandAnalysis(ok: true, shellCommand: nil, segments: [segment])
    }

    static func analyzeShellCommand(
        _ payload: String,
        cwd: String?,
        env: [String: String]?) -> ExecCommandAnalysis
    {
        guard let segments = self.splitShellCommandChain(payload) else {
            return ExecCommandAnalysis(ok: false, shellCommand: nil, segments: [])
        }
        var out: [ExecCommandSegment] = []
        out.reserveCapacity(segments.count)
        for segment in segments {
            guard let segmentArgv = ExecShellArgvTokenizer.split(segment), !segmentArgv.isEmpty,
                  let resolution = self.resolve(command: segmentArgv, cwd: cwd, env: env)
            else {
                // Fail closed on unparsable segments.
                return ExecCommandAnalysis(ok: false, shellCommand: nil, segments: [])
            }
            out.append(ExecCommandSegment(raw: segment, argv: segmentArgv, resolution: resolution))
        }
        return ExecCommandAnalysis(ok: true, shellCommand: nil, segments: out)
    }

    /// Segment resolutions for allowlist matching surfaces. Policy-blocked
    /// segments are retained — consumers must treat them as unsatisfiable and
    /// still use them for allow-always persistence (core segment semantics).
    static func resolveForAllowlist(
        command: [String],
        rawCommand: String?,
        cwd: String?,
        env: [String: String]?) -> [ExecCommandResolution]
    {
        let analysis = self.analyze(command: command, rawCommand: rawCommand, cwd: cwd, env: env)
        guard analysis.ok else {
            // Fail closed: unanalyzable commands are an allowlist miss requiring approval.
            return []
        }
        return analysis.segments.compactMap(\.resolution)
    }

    /// Mirror of core `resolveAllowlistCandidatePath`: the path used for
    /// allowlist comparisons. Falls back to the cwd-normalized raw executable
    /// when filesystem resolution found nothing (the configured pattern may
    /// still match a not-yet-existing relative target).
    func allowlistCandidatePath(cwd: String?) -> String? {
        if let resolvedPath, !resolvedPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return resolvedPath
        }
        let raw = self.rawExecutable.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return nil }
        let expanded = raw.hasPrefix("~") ? (raw as NSString).expandingTildeInPath : raw
        guard expanded.contains("/") || expanded.contains("\\") else { return nil }
        if expanded.hasPrefix("/") {
            return expanded
        }
        let trimmedCwd = cwd?.trimmingCharacters(in: .whitespacesAndNewlines)
        let base = (trimmedCwd?.isEmpty == false)
            ? trimmedCwd!
            : FileManager.default.currentDirectoryPath
        return Self.resolveAgainstBase(base, expanded)
    }

    /// Lexical `path.resolve(base, relative)` equivalent: absolute result with
    /// "." and ".." collapsed (no symlink resolution).
    private static func resolveAgainstBase(_ base: String, _ relative: String) -> String {
        let combined = base.hasSuffix("/") ? base + relative : base + "/" + relative
        var parts: [String] = []
        for component in combined.split(separator: "/") {
            if component == "." { continue }
            if component == ".." {
                if !parts.isEmpty { parts.removeLast() }
                continue
            }
            parts.append(String(component))
        }
        return "/" + parts.joined(separator: "/")
    }

    /// Mirror of core `resolveExecutablePath` + `buildCommandResolution`.
    private static func resolveExecutable(
        rawExecutable: String,
        cwd: String?,
        env: [String: String]?) -> ExecCommandResolution
    {
        let expanded = rawExecutable.hasPrefix("~") ? (rawExecutable as NSString).expandingTildeInPath : rawExecutable
        let resolvedPath = self.resolveExecutablePath(expanded, cwd: cwd, env: env)
        let resolvedRealPath = self.tryResolveRealpath(resolvedPath)
        let name = resolvedPath.map { URL(fileURLWithPath: $0).lastPathComponent } ?? rawExecutable
        return ExecCommandResolution(
            rawExecutable: rawExecutable,
            resolvedPath: resolvedPath,
            resolvedRealPath: resolvedRealPath,
            executableName: name,
            cwd: cwd)
    }

    /// Mirror of core `tryResolveRealpath`: nil when the path is missing or the
    /// symlink chain cannot be resolved.
    private static func tryResolveRealpath(_ path: String?) -> String? {
        guard let path, FileManager.default.fileExists(atPath: path) else { return nil }
        return URL(fileURLWithPath: path).resolvingSymlinksInPath().path
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
            let candidate = self.resolveAgainstBase(root, expanded)
            return self.isExecutableFile(candidate) ? candidate : nil
        }
        let processEnv = ProcessInfo.processInfo.environment
        let pathEnv = env?["PATH"] ?? env?["Path"] ?? processEnv["PATH"] ?? processEnv["Path"] ?? ""
        return self.resolveExecutableFromPathEnv(expanded, pathEnv: pathEnv)
    }

    /// POSIX `path.join(entry, executable)`: the candidate keeps the PATH
    /// entry's spelling — a relative entry yields a relative candidate that the
    /// filesystem calls below resolve against the process working directory,
    /// exactly like core's `resolveExecutableFromPathEnv`.
    static func joinPath(_ entry: String, _ executable: String) -> String {
        entry.hasSuffix("/") ? entry + executable : entry + "/" + executable
    }

    static func resolveExecutableFromPathEnv(_ executable: String, pathEnv: String) -> String? {
        for entry in pathEnv.split(separator: ":", omittingEmptySubsequences: true) {
            let candidate = self.joinPath(String(entry), executable)
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
