import Foundation

/// Mirror of core `resolvePlannedAllowlistArgv`/`resolvePlannedSegmentArgv`
/// (src/node-host/invoke-system-run-allowlist.ts,
/// src/infra/exec-approvals-analysis.ts) and `resolveAllowAlwaysPatterns`
/// (src/infra/exec-approvals-allowlist.ts).
///
/// The allowlist approves the resolution's *effective* argv; execution must run
/// that planned argv (with argv[0] pinned to the resolved executable), never
/// the original wrapper invocation.
enum ExecAllowlistPlan {
    enum PlannedArgv: Sendable {
        /// No plan applies — execute the request argv unchanged.
        case none
        /// A plan was required but could not be constructed — deny.
        case denied
        case argv([String])
    }

    static func plannedArgv(
        security: ExecSecurity,
        shellCommand: String?,
        approvedByAsk: Bool,
        analysisOk: Bool,
        allowlistSatisfied: Bool,
        segments: [ExecCommandSegment]) -> PlannedArgv
    {
        guard security == .allowlist, !approvedByAsk, shellCommand == nil, analysisOk,
              allowlistSatisfied, segments.count == 1
        else {
            return .none
        }
        return self.plannedSegmentArgv(segments[0])
    }

    /// Mirror of `resolvePlannedSegmentArgv`: effective argv with argv[0]
    /// pinned to the resolved (real) executable. Policy-blocked or empty plans
    /// deny execution.
    static func plannedSegmentArgv(_ segment: ExecCommandSegment) -> PlannedArgv {
        if segment.resolution?.policyBlocked == true {
            return .denied
        }
        var argv: [String] = if let effectiveArgv = segment.resolution?.effectiveArgv, !effectiveArgv.isEmpty {
            effectiveArgv
        } else {
            segment.argv
        }
        guard !argv.isEmpty else {
            return .denied
        }
        let resolvedExecutable = segment.resolution?.resolvedRealPath?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            ?? segment.resolution?.resolvedPath?.trimmingCharacters(in: .whitespacesAndNewlines)
            ?? ""
        if !resolvedExecutable.isEmpty {
            argv[0] = resolvedExecutable
        }
        return .argv(argv)
    }

    /// Mirror of `resolveAllowAlwaysPatterns`: derive persisted allowlist
    /// entries from canonical analysis segments. Shell wrappers themselves are
    /// never persisted; dispatch/multiplexer wrappers are unwrapped to the
    /// inner executables.
    static func allowAlwaysPatterns(
        segments: [ExecCommandSegment],
        cwd: String?,
        env: [String: String]?) -> [String]
    {
        var patterns: [String] = []
        var seen = Set<String>()
        for segment in segments {
            self.collectAllowAlwaysPattern(
                segment: segment,
                cwd: cwd,
                env: env,
                depth: 0,
                seen: &seen,
                out: &patterns)
        }
        return patterns
    }

    private static func makeSegment(
        _ argv: [String],
        cwd: String?,
        env: [String: String]?) -> ExecCommandSegment
    {
        ExecCommandSegment(
            raw: argv.joined(separator: " "),
            argv: argv,
            resolution: ExecCommandResolution.resolve(command: argv, cwd: cwd, env: env))
    }

    private static func hasExecutableMatch(
        _ segment: ExecCommandSegment,
        predicate: (String) -> Bool) -> Bool
    {
        for candidate in [segment.resolution?.executableName, segment.resolution?.rawExecutable, segment.argv.first] {
            let trimmed = candidate?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !trimmed.isEmpty, predicate(trimmed) {
                return true
            }
        }
        return false
    }

    private static func collectAllowAlwaysPattern(
        segment: ExecCommandSegment,
        cwd: String?,
        env: [String: String]?,
        depth: Int,
        seen: inout Set<String>,
        out: inout [String])
    {
        guard depth < 3 else { return }

        if self.hasExecutableMatch(segment, predicate: ExecDispatchWrapper.isDispatchWrapperExecutable) {
            guard case let .unwrapped(_, unwrapped) = ExecDispatchWrapper
                .unwrapKnownDispatchWrapperInvocation(segment.argv), !unwrapped.isEmpty
            else { return }
            self.collectAllowAlwaysPattern(
                segment: self.makeSegment(unwrapped, cwd: cwd, env: env),
                cwd: cwd,
                env: env,
                depth: depth + 1,
                seen: &seen,
                out: &out)
            return
        }

        switch ExecDispatchWrapper.unwrapKnownShellMultiplexerInvocation(segment.argv) {
        case .blocked:
            return
        case let .unwrapped(_, unwrapped):
            self.collectAllowAlwaysPattern(
                segment: self.makeSegment(unwrapped, cwd: cwd, env: env),
                cwd: cwd,
                env: env,
                depth: depth + 1,
                seen: &seen,
                out: &out)
            return
        case .notWrapper:
            break
        }

        guard let candidatePath = segment.resolution?.allowlistCandidatePath(cwd: cwd) else { return }
        guard !self.hasExecutableMatch(segment, predicate: ExecDispatchWrapper.isShellWrapperExecutable) else {
            guard let inlineCommand = ExecDispatchWrapper.extractShellWrapperInlineCommand(segment.argv) else {
                return
            }
            let nested = ExecCommandResolution.analyzeShellCommand(inlineCommand, cwd: cwd, env: env)
            guard nested.ok else { return }
            for nestedSegment in nested.segments {
                self.collectAllowAlwaysPattern(
                    segment: nestedSegment,
                    cwd: cwd,
                    env: env,
                    depth: depth + 1,
                    seen: &seen,
                    out: &out)
            }
            return
        }
        if seen.insert(candidatePath).inserted {
            out.append(candidatePath)
        }
    }
}
