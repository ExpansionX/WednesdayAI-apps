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
    ///
    /// `processCwd` is injectable so tests never mutate the shared process
    /// working directory; production callers default to the live value.
    static func resolve(
        command: [String],
        cwd: String?,
        env: [String: String]?,
        processCwd: String = FileManager.default.currentDirectoryPath) -> ExecCommandResolution?
    {
        let plan = ExecDispatchWrapper.resolveDispatchWrapperExecutionPlan(command)
        guard let raw = plan.argv.first?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
            return nil
        }
        let resolution = self.resolveExecutable(rawExecutable: raw, cwd: cwd, env: env, processCwd: processCwd)
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
        env: [String: String]?,
        processCwd: String = FileManager.default.currentDirectoryPath) -> ExecCommandAnalysis
    {
        // rawCommand is display text only; analysis is argv-based (core parity).
        let shell = ExecShellWrapperParser.extract(command: command, rawCommand: nil)
        if shell.isWrapper {
            guard let shellCommand = shell.command else {
                return ExecCommandAnalysis(ok: false, shellCommand: nil, segments: [])
            }
            let analysis = self.analyzeShellCommand(shellCommand, cwd: cwd, env: env, processCwd: processCwd)
            return ExecCommandAnalysis(ok: analysis.ok, shellCommand: shellCommand, segments: analysis.segments)
        }
        return self.analyzeArgv(command: command, cwd: cwd, env: env, processCwd: processCwd)
    }

    static func analyzeArgv(
        command: [String],
        cwd: String?,
        env: [String: String]?,
        processCwd: String = FileManager.default.currentDirectoryPath) -> ExecCommandAnalysis
    {
        let filtered = command.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        guard !filtered.isEmpty else {
            return ExecCommandAnalysis(ok: false, shellCommand: nil, segments: [])
        }
        let resolution = self.resolve(command: filtered, cwd: cwd, env: env, processCwd: processCwd)
        let segment = ExecCommandSegment(
            raw: filtered.joined(separator: " "),
            argv: filtered,
            resolution: resolution)
        return ExecCommandAnalysis(ok: true, shellCommand: nil, segments: [segment])
    }

    static func analyzeShellCommand(
        _ payload: String,
        cwd: String?,
        env: [String: String]?,
        processCwd: String = FileManager.default.currentDirectoryPath) -> ExecCommandAnalysis
    {
        guard let segments = self.splitShellCommandChain(payload) else {
            return ExecCommandAnalysis(ok: false, shellCommand: nil, segments: [])
        }
        var out: [ExecCommandSegment] = []
        out.reserveCapacity(segments.count)
        for segment in segments {
            guard let segmentArgv = ExecShellArgvTokenizer.split(segment), !segmentArgv.isEmpty,
                  let resolution = self.resolve(command: segmentArgv, cwd: cwd, env: env, processCwd: processCwd)
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
        env: [String: String]?,
        processCwd: String = FileManager.default.currentDirectoryPath) -> [ExecCommandResolution]
    {
        let analysis = self.analyze(
            command: command,
            rawCommand: rawCommand,
            cwd: cwd,
            env: env,
            processCwd: processCwd)
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
    func allowlistCandidatePath(
        cwd: String?,
        processCwd: String = FileManager.default.currentDirectoryPath) -> String?
    {
        if let resolvedPath, !resolvedPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return resolvedPath
        }
        let raw = self.rawExecutable.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return nil }
        let expanded = raw.hasPrefix("~") ? (raw as NSString).expandingTildeInPath : raw
        guard ExecPathScalars.containsUnit(expanded, ExecPathScalars.slash)
            || ExecPathScalars.containsUnit(expanded, ExecPathScalars.backslash)
        else { return nil }
        if ExecPathScalars.isAbsolute(expanded) {
            return expanded
        }
        let trimmedCwd = cwd?.trimmingCharacters(in: .whitespacesAndNewlines)
        let base = (trimmedCwd?.isEmpty == false) ? trimmedCwd! : processCwd
        return Self.resolveAgainstBase(base, expanded, processCwd: processCwd)
    }

    /// Lexical `path.resolve(base, relative)` equivalent: a relative base is
    /// first resolved against the injected process working directory (Node
    /// path.resolve semantics), then "." and ".." are collapsed into an
    /// absolute result without symlink resolution.
    static func resolveAgainstBase(_ base: String, _ relative: String, processCwd: String) -> String {
        var rooted = base
        // Root classification is byte-based: a leading slash clustered with a
        // following combining scalar ("/" + U+0301 is one Character) would
        // otherwise be misread as relative and re-rooted under processCwd.
        if !ExecPathScalars.isAbsolute(rooted) {
            rooted = ExecPathScalars.hasSuffix(processCwd, "/") ? processCwd + rooted : processCwd + "/" + rooted
        }
        let combined = ExecPathScalars.hasSuffix(rooted, "/") ? rooted + relative : rooted + "/" + relative
        return Self.collapsePath(combined)
    }

    /// Lexical POSIX path normalization (`path.join` semantics): removes "."
    /// components and duplicate separators, resolves ".." against the component
    /// stack (clamped at the root for absolute paths, preserved as leading
    /// segments for relative paths), and keeps the input's absolute/relative
    /// status.
    ///
    /// Components split on the ASCII "/" SCALAR: Character-based splitting
    /// would fuse a separator with a following combining scalar into one
    /// grapheme and skip the split, mis-nesting parent-directory resolution.
    static func collapsePath(_ path: String) -> String {
        // Byte-based root check (review T1): grapheme `hasPrefix("/")` misses a
        // leading slash fused with a following combining scalar, dropping the
        // root after scalar component splitting.
        let isAbsolute = ExecPathScalars.isAbsolute(path)
        var stack: [String] = []
        for component in Self.splitPathComponents(path) {
            switch component {
            case ".":
                continue
            case "..":
                if isAbsolute {
                    if !stack.isEmpty { stack.removeLast() }
                } else if let last = stack.last, last != ".." {
                    stack.removeLast()
                } else {
                    stack.append("..")
                }
            default:
                stack.append(component)
            }
        }
        let joined = stack.joined(separator: "/")
        if isAbsolute {
            return "/" + joined
        }
        return joined.isEmpty ? "." : joined
    }

    /// Splits on ASCII "/" and ":" scalars (used for path components and
    /// PATH-list entries respectively) independent of grapheme clustering.
    private static func splitOnAsciiScalar(_ value: String, _ separator: Unicode.Scalar) -> [String] {
        var components: [String] = []
        var current = ""
        for scalar in value.unicodeScalars {
            if scalar == separator {
                components.append(current)
                current = ""
            } else {
                current.unicodeScalars.append(scalar)
            }
        }
        components.append(current)
        return components.filter { !$0.isEmpty }
    }

    static func splitPathComponents(_ path: String) -> [String] {
        self.splitOnAsciiScalar(path, "/")
    }

    static func splitPathList(_ pathEnv: String) -> [String] {
        self.splitOnAsciiScalar(pathEnv, ":")
    }

    /// Mirror of core `resolveExecutablePath` + `buildCommandResolution`.
    private static func resolveExecutable(
        rawExecutable: String,
        cwd: String?,
        env: [String: String]?,
        processCwd: String) -> ExecCommandResolution
    {
        let expanded = ExecPathScalars.hasPrefix(rawExecutable, "~")
            ? (rawExecutable as NSString).expandingTildeInPath : rawExecutable
        let resolvedPath = self.resolveExecutablePath(expanded, cwd: cwd, env: env, processCwd: processCwd)
        let resolvedRealPath = self.tryResolveRealpath(resolvedPath, processCwd: processCwd)
        let name = resolvedPath.map { URL(fileURLWithPath: $0).lastPathComponent } ?? rawExecutable
        return ExecCommandResolution(
            rawExecutable: rawExecutable,
            resolvedPath: resolvedPath,
            resolvedRealPath: resolvedRealPath,
            executableName: name,
            cwd: cwd)
    }

    /// Mirror of core `tryResolveRealpath`: nil when the path is missing or the
    /// symlink chain cannot be resolved. Relative paths are resolved against
    /// the injected process working directory before symlink resolution.
    private static func tryResolveRealpath(_ path: String?, processCwd: String) -> String? {
        guard let path else { return nil }
        let absolute = ExecPathScalars.isAbsolute(path) ? path : self.joinPath(processCwd, path)
        guard FileManager.default.fileExists(atPath: absolute) else { return nil }
        return URL(fileURLWithPath: absolute).resolvingSymlinksInPath().path
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
        env: [String: String]?,
        processCwd: String) -> String?
    {
        if ExecPathScalars.containsUnit(expanded, ExecPathScalars.slash)
            || ExecPathScalars.containsUnit(expanded, ExecPathScalars.backslash)
        {
            if ExecPathScalars.isAbsolute(expanded) {
                return self.isExecutableFile(expanded) ? expanded : nil
            }
            let base = cwd?.trimmingCharacters(in: .whitespacesAndNewlines)
            let root = (base?.isEmpty == false) ? base! : processCwd
            let candidate = self.resolveAgainstBase(root, expanded, processCwd: processCwd)
            return self.isExecutableFile(candidate) ? candidate : nil
        }
        let processEnv = ProcessInfo.processInfo.environment
        let pathEnv = env?["PATH"] ?? env?["Path"] ?? processEnv["PATH"] ?? processEnv["Path"] ?? ""
        return self.resolveExecutableFromPathEnv(expanded, pathEnv: pathEnv, processCwd: processCwd)
    }

    /// POSIX `path.join(entry, executable)`: lexically normalizes dot
    /// components and duplicate separators while preserving the PATH entry's
    /// relative/absolute spelling — a relative entry yields a relative
    /// candidate whose existence check resolves against the injected process
    /// working directory, exactly like core's `resolveExecutableFromPathEnv`.
    static func joinPath(_ entry: String, _ executable: String) -> String {
        self.collapsePath(
            ExecPathScalars.hasSuffix(entry, "/") ? entry + executable : entry + "/" + executable)
    }

    static func resolveExecutableFromPathEnv(
        _ executable: String,
        pathEnv: String,
        processCwd: String = FileManager.default.currentDirectoryPath) -> String?
    {
        for entry in self.splitPathList(pathEnv) {
            let candidate = self.joinPath(entry, executable)
            let checkPath = ExecPathScalars.isAbsolute(candidate) ? candidate : self.joinPath(processCwd, candidate)
            if self.isExecutableFile(checkPath) {
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
        let token: UInt16
        let next: UInt16?
    }

    private static let shellFailClosedRules: [ShellTokenContext: [ShellFailClosedRule]] = [
        .unquoted: [
            ShellFailClosedRule(token: 0x60, next: nil), // `
            ShellFailClosedRule(token: 0x24, next: 0x28), // $ (
            ShellFailClosedRule(token: 0x3C, next: 0x28), // < (
            ShellFailClosedRule(token: 0x3E, next: 0x28), // > (
        ],
        .doubleQuoted: [
            ShellFailClosedRule(token: 0x60, next: nil), // `
            ShellFailClosedRule(token: 0x24, next: 0x28), // $ (
        ],
    ]

    /// Splits the payload on chain operators (`&&`, `||`, `;`, `&`, `|`, newline)
    /// while respecting quotes. Iterated on UTF-16 code units like the TS
    /// reference: Character (grapheme) iteration would fuse an ASCII delimiter
    /// with a following combining scalar and miss the quote/delimiter.
    private static func splitShellCommandChain(_ command: String) -> [String]? {
        let trimmed = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        var segments: [String] = []
        var current: [UInt16] = []
        var inSingle = false
        var inDouble = false
        var escaped = false
        let units = Array(trimmed.utf16)
        var idx = 0

        func appendCurrent() -> Bool {
            let segment = String(decoding: current, as: UTF16.self)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !segment.isEmpty else { return false }
            segments.append(segment)
            current.removeAll(keepingCapacity: true)
            return true
        }

        while idx < units.count {
            let unit = units[idx]
            let next: UInt16? = idx + 1 < units.count ? units[idx + 1] : nil

            if escaped {
                current.append(unit)
                escaped = false
                idx += 1
                continue
            }

            if unit == 0x5C, !inSingle { // backslash
                current.append(unit)
                escaped = true
                idx += 1
                continue
            }

            if unit == 0x27, !inDouble { // '
                inSingle.toggle()
                current.append(unit)
                idx += 1
                continue
            }

            if unit == 0x22, !inSingle { // "
                inDouble.toggle()
                current.append(unit)
                idx += 1
                continue
            }

            if !inSingle, self.shouldFailClosedForShell(unit: unit, next: next, inDouble: inDouble) {
                // Fail closed on command/process substitution in allowlist mode,
                // including command substitution inside double-quoted shell strings.
                return nil
            }

            if !inSingle, !inDouble {
                let prev: UInt16? = idx > 0 ? units[idx - 1] : nil
                if let delimiterStep = self.chainDelimiterStep(unit: unit, prev: prev, next: next) {
                    guard appendCurrent() else { return nil }
                    idx += delimiterStep
                    continue
                }
            }

            current.append(unit)
            idx += 1
        }

        if escaped || inSingle || inDouble { return nil }
        guard appendCurrent() else { return nil }
        return segments
    }

    private static func shouldFailClosedForShell(unit: UInt16, next: UInt16?, inDouble: Bool) -> Bool {
        let context: ShellTokenContext = inDouble ? .doubleQuoted : .unquoted
        guard let rules = self.shellFailClosedRules[context] else {
            return false
        }
        for rule in rules {
            if unit == rule.token, rule.next == nil || next == rule.next {
                return true
            }
        }
        return false
    }

    private static func chainDelimiterStep(unit: UInt16, prev: UInt16?, next: UInt16?) -> Int? {
        if unit == 0x3B || unit == 0x0A { // ; or newline
            return 1
        }
        if unit == 0x26 { // &
            if next == 0x26 {
                return 2
            }
            // Keep fd redirections like 2>&1 or &>file intact.
            let prevIsRedirect = prev == 0x3E // >
            let nextIsRedirect = next == 0x3E // >
            return (!prevIsRedirect && !nextIsRedirect) ? 1 : nil
        }
        if unit == 0x7C { // |
            if next == 0x7C || next == 0x26 { // || or |&
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
            if self.needsQuotes(arg) { return "\"\(self.escaped(arg))\"" }
            return arg
        }.joined(separator: " ")
    }

    /// TS `/\s|"/.test(arg)` per UTF-16 code unit. `Character.isWhitespace`
    /// would diverge (U+0085 is whitespace in Unicode but not in JS `\s`;
    /// U+FEFF is in JS `\s` but not Unicode White_Space) and grapheme equality
    /// would miss a `"` fused with a following combining scalar.
    private static func needsQuotes(_ arg: String) -> Bool {
        arg.utf16.contains { unit in
            ExecShellArgvTokenizer.jsWhitespace.contains(unit) || unit == 0x22
        }
    }

    private static func escaped(_ arg: String) -> String {
        // TS arg.replace(/"/g, '\\"') per code unit: a '"' fused with a
        // following combining scalar is one Character, so grapheme-based
        // replacingOccurrences would miss it.
        var out = ""
        out.reserveCapacity(arg.utf8.count + 2)
        for scalar in arg.unicodeScalars {
            if scalar == "\"" {
                out.unicodeScalars.append("\\")
                out.unicodeScalars.append("\"")
            } else {
                out.unicodeScalars.append(scalar)
            }
        }
        return out
    }

    static func displayString(for argv: [String], rawCommand: String?) -> String {
        let trimmed = rawCommand?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmed.isEmpty { return trimmed }
        return self.displayString(for: argv)
    }
}
