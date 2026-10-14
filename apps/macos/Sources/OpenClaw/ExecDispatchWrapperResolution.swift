import Foundation

/// Swift mirror of WednesdayAI-core `src/infra/exec-wrapper-resolution.ts`
/// (plus `resolveInlineCommandMatch` from `src/infra/shell-inline-command.ts` and the
/// argv tokenizer from `src/utils/shell-argv.ts`).
///
/// Semantics must stay in lockstep with core so the shared parity fixtures in
/// `apps/shared/contracts/fixtures/` keep passing on both sides.
enum ExecDispatchWrapper {
    static let maxDepth = 4

    // MARK: - Wrapper name sets (canonical names; `.exe` is stripped during normalization)

    private static let posixShellWrapperNames: Set<String> = ["ash", "bash", "dash", "fish", "ksh", "sh", "zsh"]
    private static let cmdWrapperNames: Set<String> = ["cmd"]
    private static let powershellWrapperNames: Set<String> = ["powershell", "pwsh"]
    private static let shellMultiplexerWrapperNames: Set<String> = ["busybox", "toybox"]
    private static let transparentDispatchWrapperNames: Set<String> = ["nice", "nohup", "stdbuf", "timeout"]

    static let posixInlineCommandFlags: Set<String> = ["-lc", "-c", "--command"]
    static let powershellInlineCommandFlags: Set<String> = ["-c", "-command", "--command"]

    private static let envOptionsWithValue: Set<String> = [
        "-u", "--unset", "-c", "--chdir", "-s", "--split-string",
        "--default-signal", "--ignore-signal", "--block-signal",
    ]
    private static let envFlagOptions: Set<String> = ["-i", "--ignore-environment", "-0", "--null"]
    private static let envInlineValuePrefixes: Set<String> = [
        "-u", "-c", "-s", "--unset=", "--chdir=", "--split-string=",
        "--default-signal=", "--ignore-signal=", "--block-signal=",
    ]
    private static let niceOptionsWithValue: Set<String> = ["-n", "--adjustment", "--priority"]
    private static let stdbufOptionsWithValue: Set<String> = ["-i", "--input", "-o", "--output", "-e", "--error"]
    private static let timeoutFlagOptions: Set<String> = ["--foreground", "--preserve-status", "-v", "--verbose"]
    private static let timeoutOptionsWithValue: Set<String> = ["-k", "--kill-after", "-s", "--signal"]

    // MARK: - Name normalization

    static func basenameLower(_ token: String) -> String {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        let normalized = trimmed.replacingOccurrences(of: "\\", with: "/")
        let base = normalized.split(separator: "/").last.map(String.init) ?? normalized
        return base.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    static func normalizeExecutableToken(_ token: String) -> String {
        let base = self.basenameLower(token)
        guard base.hasSuffix(".exe") else { return base }
        return String(base.dropLast(4))
    }

    static func isShellWrapperExecutable(_ token: String) -> Bool {
        self.shellWrapperNames.contains(self.normalizeExecutableToken(token))
    }

    private static var shellWrapperNames: Set<String> {
        posixShellWrapperNames.union(cmdWrapperNames).union(powershellWrapperNames)
    }

    // MARK: - Unwrap results

    enum UnwrapResult: Sendable {
        case notWrapper
        case blocked(wrapper: String)
        case unwrapped(wrapper: String, argv: [String])

        var wrapperName: String? {
            switch self {
            case .notWrapper: nil
            case let .blocked(wrapper): wrapper
            case let .unwrapped(wrapper, _): wrapper
            }
        }
    }

    /// Execution plan for an argv chain: the effective argv after transparent dispatch
    /// wrappers, the wrapper chain, and whether policy blocks the invocation outright.
    struct ExecutionPlan: Sendable {
        let argv: [String]
        let wrappers: [String]
        let policyBlocked: Bool
        let blockedWrapper: String?
    }

    // MARK: - Shell multiplexers (busybox/toybox)

    static func unwrapKnownShellMultiplexerInvocation(_ argv: [String]) -> UnwrapResult {
        guard let token0 = argv.first?.trimmingCharacters(in: .whitespacesAndNewlines), !token0.isEmpty else {
            return .notWrapper
        }
        let wrapper = self.normalizeExecutableToken(token0)
        guard self.shellMultiplexerWrapperNames.contains(wrapper) else {
            return .notWrapper
        }

        var appletIndex = 1
        if appletIndex < argv.count, argv[appletIndex].trimmingCharacters(in: .whitespacesAndNewlines) == "--" {
            appletIndex += 1
        }
        let applet = appletIndex < argv.count ? argv[appletIndex].trimmingCharacters(in: .whitespacesAndNewlines) : ""
        guard !applet.isEmpty, self.isShellWrapperExecutable(applet) else {
            return .blocked(wrapper: wrapper)
        }

        let unwrapped = Array(argv[appletIndex...])
        if unwrapped.isEmpty {
            return .blocked(wrapper: wrapper)
        }
        return .unwrapped(wrapper: wrapper, argv: unwrapped)
    }

    // MARK: - Dispatch wrappers (env, nice, nohup, stdbuf, timeout; sudo & friends blocked)

    static func isEnvAssignment(_ token: String) -> Bool {
        token.range(of: #"^[A-Za-z_][A-Za-z0-9_]*=.*"#, options: .regularExpression) != nil
    }

    private static func flagPart(ofLowerToken lower: String) -> String {
        lower.split(separator: "=", maxSplits: 1).first.map(String.init) ?? lower
    }

    private static func hasEnvInlineValuePrefix(_ lower: String) -> Bool {
        self.envInlineValuePrefixes.contains { lower.hasPrefix($0) }
    }

    private enum ScanDirective {
        case `continue`
        case consumeNext
        case stop
        case invalid
    }

    private struct ScanParams {
        var separators: Set<String> = []
        var onToken: (String, String) -> ScanDirective
        var adjustCommandIndex: ((Int, [String]) -> Int?)?
    }

    private static func scanWrapperInvocation(_ argv: [String], params: ScanParams) -> [String]? {
        var idx = 1
        var expectsOptionValue = false
        while idx < argv.count {
            let token = argv[idx].trimmingCharacters(in: .whitespacesAndNewlines)
            if token.isEmpty {
                idx += 1
                continue
            }
            if expectsOptionValue {
                expectsOptionValue = false
                idx += 1
                continue
            }
            if params.separators.contains(token) {
                idx += 1
                break
            }
            let directive = params.onToken(token, token.lowercased())
            if directive == .stop {
                break
            }
            if directive == .invalid {
                return nil
            }
            if directive == .consumeNext {
                expectsOptionValue = true
            }
            idx += 1
        }
        if expectsOptionValue {
            return nil
        }
        let commandIndex = params.adjustCommandIndex?(idx, argv) ?? idx
        guard commandIndex < argv.count else {
            return nil
        }
        return Array(argv[commandIndex...])
    }

    static func unwrapEnvInvocation(_ argv: [String]) -> [String]? {
        let params = ScanParams(separators: ["--", "-"], onToken: { token, lower in
            if self.isEnvAssignment(token) {
                return .continue
            }
            if !token.hasPrefix("-") || token == "-" {
                return .stop
            }
            let flag = self.flagPart(ofLowerToken: lower)
            if self.envFlagOptions.contains(flag) {
                return .continue
            }
            if self.envOptionsWithValue.contains(flag) {
                return lower.contains("=") ? .continue : .consumeNext
            }
            if self.hasEnvInlineValuePrefix(lower) {
                return .continue
            }
            return .invalid
        })
        return self.scanWrapperInvocation(argv, params: params)
    }

    /// Whether the env invocation mutates the child environment (assignments, flags, unknown
    /// options). A bare `env <command>` with no modifiers is transparent.
    static func envInvocationUsesModifiers(_ argv: [String]) -> Bool {
        var idx = 1
        var expectsOptionValue = false
        while idx < argv.count {
            let token = argv[idx].trimmingCharacters(in: .whitespacesAndNewlines)
            if token.isEmpty {
                idx += 1
                continue
            }
            if expectsOptionValue {
                return true
            }
            if token == "--" || token == "-" {
                break
            }
            if self.isEnvAssignment(token) {
                return true
            }
            if !token.hasPrefix("-") || token == "-" {
                break
            }
            let lower = token.lowercased()
            let flag = self.flagPart(ofLowerToken: lower)
            if self.envFlagOptions.contains(flag) {
                return true
            }
            if self.envOptionsWithValue.contains(flag) {
                if lower.contains("=") {
                    return true
                }
                expectsOptionValue = true
                idx += 1
                continue
            }
            if self.hasEnvInlineValuePrefix(lower) {
                return true
            }
            // Unknown env flags are treated conservatively as modifiers.
            return true
        }
        return false
    }

    private static func unwrapDashOptionInvocation(
        _ argv: [String],
        onFlag: @escaping (String, String) -> ScanDirective,
        adjustCommandIndex: ((Int, [String]) -> Int?)? = nil) -> [String]?
    {
        let params = ScanParams(
            separators: ["--"],
            onToken: { token, lower in
                if !token.hasPrefix("-") || token == "-" {
                    return .stop
                }
                return onFlag(self.flagPart(ofLowerToken: lower), lower)
            },
            adjustCommandIndex: adjustCommandIndex)
        return self.scanWrapperInvocation(argv, params: params)
    }

    private static func unwrapNiceInvocation(_ argv: [String]) -> [String]? {
        self.unwrapDashOptionInvocation(argv, onFlag: { flag, lower in
            if lower.range(of: #"^-\d+$"#, options: .regularExpression) != nil {
                return .continue
            }
            if self.niceOptionsWithValue.contains(flag) {
                return lower.contains("=") || lower != flag ? .continue : .consumeNext
            }
            if lower.hasPrefix("-n"), lower.count > 2 {
                return .continue
            }
            return .invalid
        })
    }

    private static func unwrapNohupInvocation(_ argv: [String]) -> [String]? {
        let params = ScanParams(separators: ["--"], onToken: { token, lower in
            if !token.hasPrefix("-") || token == "-" {
                return .stop
            }
            return lower == "--help" || lower == "--version" ? .continue : .invalid
        })
        return self.scanWrapperInvocation(argv, params: params)
    }

    private static func unwrapStdbufInvocation(_ argv: [String]) -> [String]? {
        self.unwrapDashOptionInvocation(argv, onFlag: { flag, lower in
            guard self.stdbufOptionsWithValue.contains(flag) else {
                return .invalid
            }
            return lower.contains("=") ? .continue : .consumeNext
        })
    }

    private static func unwrapTimeoutInvocation(_ argv: [String]) -> [String]? {
        self.unwrapDashOptionInvocation(
            argv,
            onFlag: { flag, lower in
                if self.timeoutFlagOptions.contains(flag) {
                    return .continue
                }
                if self.timeoutOptionsWithValue.contains(flag) {
                    return lower.contains("=") ? .continue : .consumeNext
                }
                return .invalid
            },
            adjustCommandIndex: { commandIndex, current in
                // timeout consumes a required duration token before the wrapped command.
                let wrappedCommandIndex = commandIndex + 1
                return wrappedCommandIndex < current.count ? wrappedCommandIndex : nil
            })
    }

    static func unwrapKnownDispatchWrapperInvocation(_ argv: [String]) -> UnwrapResult {
        guard let token0 = argv.first?.trimmingCharacters(in: .whitespacesAndNewlines), !token0.isEmpty else {
            return .notWrapper
        }
        let wrapper = self.normalizeExecutableToken(token0)
        func result(_ unwrapped: [String]?) -> UnwrapResult {
            guard let unwrapped else { return .blocked(wrapper: wrapper) }
            return .unwrapped(wrapper: wrapper, argv: unwrapped)
        }
        switch wrapper {
        case "env":
            return result(self.unwrapEnvInvocation(argv))
        case "nice":
            return result(self.unwrapNiceInvocation(argv))
        case "nohup":
            return result(self.unwrapNohupInvocation(argv))
        case "stdbuf":
            return result(self.unwrapStdbufInvocation(argv))
        case "timeout":
            return result(self.unwrapTimeoutInvocation(argv))
        case "chrt", "doas", "ionice", "setsid", "sudo", "taskset":
            return .blocked(wrapper: wrapper)
        default:
            return .notWrapper
        }
    }

    // MARK: - Execution plan

    private static func isSemanticDispatchWrapperUsage(wrapper: String, argv: [String]) -> Bool {
        if wrapper == "env" {
            return self.envInvocationUsesModifiers(argv)
        }
        return !self.transparentDispatchWrapperNames.contains(wrapper)
    }

    static func resolveDispatchWrapperExecutionPlan(
        _ argv: [String],
        maxDepth: Int = ExecDispatchWrapper.maxDepth) -> ExecutionPlan
    {
        var current = argv
        var wrappers: [String] = []
        for _ in 0..<maxDepth {
            let unwrap = self.unwrapKnownDispatchWrapperInvocation(current)
            if case let .blocked(wrapper) = unwrap {
                return ExecutionPlan(argv: current, wrappers: wrappers, policyBlocked: true, blockedWrapper: wrapper)
            }
            guard case let .unwrapped(wrapper, unwrappedArgv) = unwrap, !unwrappedArgv.isEmpty else {
                break
            }
            wrappers.append(wrapper)
            if self.isSemanticDispatchWrapperUsage(wrapper: wrapper, argv: current) {
                return ExecutionPlan(argv: current, wrappers: wrappers, policyBlocked: true, blockedWrapper: wrapper)
            }
            current = unwrappedArgv
        }
        if wrappers.count >= maxDepth {
            let overflow = self.unwrapKnownDispatchWrapperInvocation(current)
            if let overflowWrapper = overflow.wrapperName {
                return ExecutionPlan(
                    argv: current,
                    wrappers: wrappers,
                    policyBlocked: true,
                    blockedWrapper: overflowWrapper)
            }
        }
        return ExecutionPlan(argv: current, wrappers: wrappers, policyBlocked: false, blockedWrapper: nil)
    }

    static func unwrapDispatchWrappersForResolution(
        _ argv: [String],
        maxDepth: Int = ExecDispatchWrapper.maxDepth) -> [String]
    {
        self.resolveDispatchWrapperExecutionPlan(argv, maxDepth: maxDepth).argv
    }

    // MARK: - Shell wrapper payload extraction

    private enum ShellWrapperKind {
        case posix
        case cmd
        case powershell
    }

    private struct ShellWrapperSpec {
        let kind: ShellWrapperKind
        let names: Set<String>
    }

    private static let shellWrapperSpecs: [ShellWrapperSpec] = [
        ShellWrapperSpec(kind: .posix, names: posixShellWrapperNames),
        ShellWrapperSpec(kind: .cmd, names: cmdWrapperNames),
        ShellWrapperSpec(kind: .powershell, names: powershellWrapperNames),
    ]

    private static func findShellWrapperSpec(_ baseExecutable: String) -> ShellWrapperSpec? {
        self.shellWrapperSpecs.first { $0.names.contains(baseExecutable) }
    }

    struct InlineCommandMatch: Sendable {
        let command: String?
        let valueTokenIndex: Int?
    }

    /// Mirror of core `resolveInlineCommandMatch` (shell-inline-command.ts).
    static func resolveInlineCommandMatch(
        _ argv: [String],
        flags: Set<String>,
        allowCombinedC: Bool = false) -> InlineCommandMatch
    {
        guard argv.count > 1 else {
            return InlineCommandMatch(command: nil, valueTokenIndex: nil)
        }
        for i in 1..<argv.count {
            let token = argv[i].trimmingCharacters(in: .whitespacesAndNewlines)
            if token.isEmpty {
                continue
            }
            let lower = token.lowercased()
            if lower == "--" {
                break
            }
            if flags.contains(lower) {
                let valueTokenIndex = i + 1 < argv.count ? i + 1 : nil
                let command = i + 1 < argv.count ? argv[i + 1].trimmingCharacters(in: .whitespacesAndNewlines) : ""
                return InlineCommandMatch(command: command.isEmpty ? nil : command, valueTokenIndex: valueTokenIndex)
            }
            let matchesCombinedC = token.range(
                of: #"^-[^-]*c[^-]*$"#,
                options: [.regularExpression, .caseInsensitive]) != nil
            if allowCombinedC, matchesCombinedC {
                // The lowercase and original token share character offsets for ASCII flags.
                let inline = self.inlineCommandAfterC(token: token, lower: lower)
                if let inline, !inline.isEmpty {
                    return InlineCommandMatch(command: inline, valueTokenIndex: i)
                }
                let valueTokenIndex = i + 1 < argv.count ? i + 1 : nil
                let command = i + 1 < argv.count ? argv[i + 1].trimmingCharacters(in: .whitespacesAndNewlines) : ""
                return InlineCommandMatch(command: command.isEmpty ? nil : command, valueTokenIndex: valueTokenIndex)
            }
        }
        return InlineCommandMatch(command: nil, valueTokenIndex: nil)
    }

    private static func inlineCommandAfterC(token: String, lower: String) -> String? {
        guard let lowerIndex = lower.firstIndex(of: "c") else { return nil }
        let offset = lower.distance(from: lower.startIndex, to: lowerIndex)
        guard offset + 1 <= token.count else { return nil }
        let tokenIndex = token.index(token.startIndex, offsetBy: offset + 1)
        return String(token[tokenIndex...]).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func extractCmdInlineCommand(_ argv: [String]) -> String? {
        guard let idx = argv.firstIndex(where: {
            let token = $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            return token == "/c" || token == "/k"
        }) else {
            return nil
        }
        let tailIndex = idx + 1
        guard tailIndex < argv.count else {
            return nil
        }
        let payload = argv[tailIndex...].joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
        return payload.isEmpty ? nil : payload
    }

    private static func extractShellWrapperPayload(_ argv: [String], spec: ShellWrapperSpec) -> String? {
        switch spec.kind {
        case .posix:
            self.resolveInlineCommandMatch(argv, flags: self.posixInlineCommandFlags, allowCombinedC: true).command
        case .cmd:
            self.extractCmdInlineCommand(argv)
        case .powershell:
            self.resolveInlineCommandMatch(argv, flags: self.powershellInlineCommandFlags).command
        }
    }

    // MARK: - Env manipulation before shell wrapper

    private static func hasEnvManipulationBeforeShellWrapperInternal(
        _ argv: [String],
        depth: Int,
        envManipulationSeen: Bool) -> Bool
    {
        if depth >= self.maxDepth {
            return false
        }
        guard let token0 = argv.first?.trimmingCharacters(in: .whitespacesAndNewlines), !token0.isEmpty else {
            return false
        }

        let dispatchUnwrap = self.unwrapKnownDispatchWrapperInvocation(argv)
        if case .blocked = dispatchUnwrap {
            return false
        }
        if case let .unwrapped(wrapper, unwrappedArgv) = dispatchUnwrap {
            let nextEnvManipulationSeen =
                envManipulationSeen || (wrapper == "env" && self.envInvocationUsesModifiers(argv))
            return self.hasEnvManipulationBeforeShellWrapperInternal(
                unwrappedArgv,
                depth: depth + 1,
                envManipulationSeen: nextEnvManipulationSeen)
        }

        let shellMultiplexerUnwrap = self.unwrapKnownShellMultiplexerInvocation(argv)
        if case .blocked = shellMultiplexerUnwrap {
            return false
        }
        if case let .unwrapped(_, unwrappedArgv) = shellMultiplexerUnwrap {
            return self.hasEnvManipulationBeforeShellWrapperInternal(
                unwrappedArgv,
                depth: depth + 1,
                envManipulationSeen: envManipulationSeen)
        }

        guard let wrapper = findShellWrapperSpec(normalizeExecutableToken(token0)) else {
            return false
        }
        guard self.extractShellWrapperPayload(argv, spec: wrapper) != nil else {
            return false
        }
        return envManipulationSeen
    }

    static func hasEnvManipulationBeforeShellWrapper(_ argv: [String]) -> Bool {
        self.hasEnvManipulationBeforeShellWrapperInternal(argv, depth: 0, envManipulationSeen: false)
    }

    // MARK: - Shell wrapper command extraction

    struct ShellWrapperCommand: Sendable {
        let isWrapper: Bool
        let command: String?
    }

    static func extractShellWrapperInlineCommand(_ argv: [String]) -> String? {
        self.extractShellWrapperCommandInternal(argv, rawCommand: nil, depth: 0).command
    }

    static func extractShellWrapperCommand(_ argv: [String], rawCommand: String?) -> ShellWrapperCommand {
        let trimmed = rawCommand?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let normalized = trimmed.isEmpty ? nil : trimmed
        return self.extractShellWrapperCommandInternal(argv, rawCommand: normalized, depth: 0)
    }

    private static func extractShellWrapperCommandInternal(
        _ argv: [String],
        rawCommand: String?,
        depth: Int) -> ShellWrapperCommand
    {
        if depth >= self.maxDepth {
            return ShellWrapperCommand(isWrapper: false, command: nil)
        }
        guard let token0 = argv.first?.trimmingCharacters(in: .whitespacesAndNewlines), !token0.isEmpty else {
            return ShellWrapperCommand(isWrapper: false, command: nil)
        }

        let dispatchUnwrap = self.unwrapKnownDispatchWrapperInvocation(argv)
        if case .blocked = dispatchUnwrap {
            return ShellWrapperCommand(isWrapper: false, command: nil)
        }
        if case let .unwrapped(_, unwrappedArgv) = dispatchUnwrap {
            return self.extractShellWrapperCommandInternal(unwrappedArgv, rawCommand: rawCommand, depth: depth + 1)
        }

        let shellMultiplexerUnwrap = self.unwrapKnownShellMultiplexerInvocation(argv)
        if case .blocked = shellMultiplexerUnwrap {
            return ShellWrapperCommand(isWrapper: false, command: nil)
        }
        if case let .unwrapped(_, unwrappedArgv) = shellMultiplexerUnwrap {
            return self.extractShellWrapperCommandInternal(unwrappedArgv, rawCommand: rawCommand, depth: depth + 1)
        }

        guard let wrapper = findShellWrapperSpec(normalizeExecutableToken(token0)) else {
            return ShellWrapperCommand(isWrapper: false, command: nil)
        }
        guard let payload = extractShellWrapperPayload(argv, spec: wrapper) else {
            return ShellWrapperCommand(isWrapper: false, command: nil)
        }
        return ShellWrapperCommand(isWrapper: true, command: rawCommand ?? payload)
    }
}

/// Mirror of core `splitShellArgs` (src/utils/shell-argv.ts). Returns nil for
/// unterminated quotes/escapes so callers can fail closed.
enum ExecShellArgvTokenizer {
    static func split(_ raw: String) -> [String]? {
        var tokens: [String] = []
        var buf = ""
        var inSingle = false
        var inDouble = false
        var escaped = false

        func pushToken() {
            if !buf.isEmpty {
                tokens.append(buf)
                buf = ""
            }
        }

        let chars = Array(raw)
        var i = 0
        while i < chars.count {
            let ch = chars[i]
            if escaped {
                buf.append(ch)
                escaped = false
                i += 1
                continue
            }
            if !inSingle, !inDouble, ch == "\\" {
                escaped = true
                i += 1
                continue
            }
            if inSingle {
                if ch == "'" {
                    inSingle = false
                } else {
                    buf.append(ch)
                }
                i += 1
                continue
            }
            if inDouble {
                let next: Character? = i + 1 < chars.count ? chars[i + 1] : nil
                if ch == "\\", let next, "\\\r\n\"$`".contains(next) {
                    buf.append(next)
                    i += 2
                    continue
                }
                if ch == "\"" {
                    inDouble = false
                } else {
                    buf.append(ch)
                }
                i += 1
                continue
            }
            if ch == "'" {
                inSingle = true
                i += 1
                continue
            }
            if ch == "\"" {
                inDouble = true
                i += 1
                continue
            }
            if ch.isWhitespace {
                pushToken()
                i += 1
                continue
            }
            buf.append(ch)
            i += 1
        }

        if escaped || inSingle || inDouble {
            return nil
        }
        pushToken()
        return tokens
    }
}
