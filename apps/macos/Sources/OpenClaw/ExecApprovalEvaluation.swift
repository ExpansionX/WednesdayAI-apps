import Foundation

/// Pure policy outcome for a system.run request, mirroring the node-host
/// policy inputs in core (`evaluateSystemRunAllowlist` +
/// `evaluateSystemRunPolicy`'s analysis/satisfaction fields).
struct ExecPolicyOutcome: Sendable {
    /// Post-gate analysis state: a shell wrapper invocation under allowlist
    /// security forces this false, mirroring `shellWrapperBlocked` in core.
    var analysisOk: Bool
    var allowlistSatisfied: Bool
    var allowlistMatches: [ExecAllowlistEntry]
    var skillAllow: Bool
    var shellWrapperBlocked: Bool
}

struct ExecApprovalEvaluation {
    let command: [String]
    let displayCommand: String
    let agentId: String?
    let security: ExecSecurity
    let ask: ExecAsk
    let env: [String: String]
    let resolution: ExecCommandResolution?
    let analysisOk: Bool
    let shellCommand: String?
    let shellWrapperBlocked: Bool
    let segments: [ExecCommandSegment]
    let allowlistResolutions: [ExecCommandResolution]
    let allowlistMatches: [ExecAllowlistEntry]
    let allowlistSatisfied: Bool
    let allowlistMatch: ExecAllowlistEntry?
    let skillAllow: Bool

    init(
        command: [String],
        displayCommand: String,
        agentId: String?,
        security: ExecSecurity,
        ask: ExecAsk,
        env: [String: String],
        resolution: ExecCommandResolution?,
        analysisOk: Bool = false,
        shellCommand: String? = nil,
        shellWrapperBlocked: Bool = false,
        segments: [ExecCommandSegment] = [],
        allowlistResolutions: [ExecCommandResolution] = [],
        allowlistMatches: [ExecAllowlistEntry] = [],
        allowlistSatisfied: Bool = false,
        allowlistMatch: ExecAllowlistEntry? = nil,
        skillAllow: Bool = false)
    {
        self.command = command
        self.displayCommand = displayCommand
        self.agentId = agentId
        self.security = security
        self.ask = ask
        self.env = env
        self.resolution = resolution
        self.analysisOk = analysisOk
        self.shellCommand = shellCommand
        self.shellWrapperBlocked = shellWrapperBlocked
        self.segments = segments
        self.allowlistResolutions = allowlistResolutions
        self.allowlistMatches = allowlistMatches
        self.allowlistSatisfied = allowlistSatisfied
        self.allowlistMatch = allowlistMatch
        self.skillAllow = skillAllow
    }
}

enum ExecApprovalEvaluator {
    static func evaluate(
        command: [String],
        rawCommand: String?,
        cwd: String?,
        envOverrides: [String: String]?,
        agentId: String?,
        processCwd: String = FileManager.default.currentDirectoryPath) async -> ExecApprovalEvaluation
    {
        let trimmedAgent = agentId?.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedAgentId = (trimmedAgent?.isEmpty == false) ? trimmedAgent : nil
        let approvals = ExecApprovalsStore.resolve(agentId: normalizedAgentId)
        let security = approvals.agent.security
        let ask = approvals.agent.ask
        // Shell detection is display-independent: rawCommand is display text only.
        let shellWrapper = ExecShellWrapperParser.extract(command: command, rawCommand: nil).isWrapper
        let env = HostEnvSanitizer.sanitize(overrides: envOverrides, shellWrapper: shellWrapper)
        let displayCommand = ExecCommandFormatter.displayString(for: command, rawCommand: rawCommand)
        let analysis = ExecCommandResolution.analyze(
            command: command,
            rawCommand: rawCommand,
            cwd: cwd,
            env: env,
            processCwd: processCwd)
        // Mirror core invoke-system-run.ts: skip the skills-status fetch
        // entirely when skill auto-allow is disabled (no gateway dependency for
        // deny/prompt/execute decisions that cannot use skills).
        let skillTrust = approvals.agent.autoAllowSkills
            ? await SkillBinsCache.shared.currentTrustEntries(processCwd: processCwd)
            : []
        let outcome = Self.evaluatePolicy(
            security: security,
            shellCommand: analysis.shellCommand,
            analysis: analysis,
            allowlist: approvals.allowlist,
            autoAllowSkills: approvals.agent.autoAllowSkills,
            skillTrust: skillTrust,
            cwd: cwd,
            processCwd: processCwd)

        return ExecApprovalEvaluation(
            command: command,
            displayCommand: displayCommand,
            agentId: normalizedAgentId,
            security: security,
            ask: ask,
            env: env,
            resolution: analysis.segments.first?.resolution,
            analysisOk: outcome.analysisOk,
            shellCommand: analysis.shellCommand,
            shellWrapperBlocked: outcome.shellWrapperBlocked,
            segments: analysis.segments,
            allowlistResolutions: analysis.segments.compactMap(\.resolution),
            allowlistMatches: outcome.allowlistMatches,
            allowlistSatisfied: outcome.allowlistSatisfied,
            allowlistMatch: outcome.allowlistSatisfied ? outcome.allowlistMatches.first : nil,
            skillAllow: outcome.skillAllow)
    }

    /// Mirror of core `evaluateExecAllowlist`/`evaluateSegments` plus the
    /// node-host mandatory shell gate (`shellWrapperBlocked`): under allowlist
    /// security, a recognized shell wrapper always requires explicit approval
    /// even when every inner segment would match.
    static func evaluatePolicy(
        security: ExecSecurity,
        shellCommand: String?,
        analysis: ExecCommandAnalysis,
        allowlist: [ExecAllowlistEntry],
        autoAllowSkills: Bool,
        skillTrust: [SkillBinTrust.Entry],
        cwd: String?,
        processCwd: String = FileManager.default.currentDirectoryPath) -> ExecPolicyOutcome
    {
        let shellWrapperBlocked = security == .allowlist && shellCommand != nil
        let analysisOk = shellWrapperBlocked ? false : analysis.ok
        var satisfied = analysisOk && !analysis.segments.isEmpty
        var skillAllowAll = analysisOk && !analysis.segments.isEmpty
        var matches: [ExecAllowlistEntry] = []

        if satisfied {
            let trust = SkillBinTrust.buildIndex(skillTrust, processCwd: processCwd)
            let allowSkills = autoAllowSkills && !trust.isEmpty
            for segment in analysis.segments {
                let segmentMatch = Self.allowlistMatch(
                    segment: segment, allowlist: allowlist, cwd: cwd, processCwd: processCwd)
                let segmentSkillAllow = Self.isSkillAutoAllowed(
                    segment: segment, allowSkills: allowSkills, trust: trust, processCwd: processCwd)
                if let segmentMatch { matches.append(segmentMatch) }
                satisfied = satisfied && (segmentMatch != nil || segmentSkillAllow)
                skillAllowAll = skillAllowAll && segmentSkillAllow
            }
        }

        return ExecPolicyOutcome(
            analysisOk: analysisOk,
            allowlistSatisfied: shellWrapperBlocked ? false : satisfied,
            allowlistMatches: shellWrapperBlocked ? [] : matches,
            skillAllow: shellWrapperBlocked ? false : skillAllowAll,
            shellWrapperBlocked: shellWrapperBlocked)
    }

    private static func allowlistMatch(
        segment: ExecCommandSegment,
        allowlist: [ExecAllowlistEntry],
        cwd: String?,
        processCwd: String) -> ExecAllowlistEntry?
    {
        guard let resolution = segment.resolution, !resolution.policyBlocked else { return nil }
        var candidate = resolution
        if let candidatePath = resolution.allowlistCandidatePath(cwd: cwd, processCwd: processCwd) {
            candidate = ExecCommandResolution(
                rawExecutable: resolution.rawExecutable,
                resolvedPath: candidatePath,
                resolvedRealPath: resolution.resolvedRealPath,
                executableName: resolution.executableName,
                cwd: resolution.cwd,
                effectiveArgv: resolution.effectiveArgv,
                wrapperChain: resolution.wrapperChain,
                policyBlocked: resolution.policyBlocked,
                blockedWrapper: resolution.blockedWrapper)
        }
        return ExecAllowlistMatcher.match(entries: allowlist, resolution: candidate)
    }

    /// Mirror of core `isSkillAutoAllowedSegment`: skill auto-allow requires a
    /// resolved executable, rejects path-scoped raw executables, and only
    /// trusts the resolved path registered for that bin name. Both sides
    /// normalize against the injected process working directory.
    static func isSkillAutoAllowed(
        segment: ExecCommandSegment,
        allowSkills: Bool,
        trust: [String: Set<String>],
        processCwd: String = FileManager.default.currentDirectoryPath) -> Bool
    {
        guard allowSkills, let resolution = segment.resolution, !resolution.policyBlocked else { return false }
        guard resolution.resolvedPath != nil else { return false }
        let rawExecutable = resolution.rawExecutable
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !rawExecutable.isEmpty,
              // TS isPathScopedExecutableToken: code-unit separators; grapheme
              // contains would miss a "/" fused with a following combining
              // scalar and let a path-scoped token reach name trust.
              !ExecPathScalars.containsUnit(rawExecutable, ExecPathScalars.slash),
              !ExecPathScalars.containsUnit(rawExecutable, ExecPathScalars.backslash)
        else { return false }
        let executableName = resolution.executableName
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        guard !executableName.isEmpty,
              let resolvedPath = resolution.resolvedPath?
                  .trimmingCharacters(in: .whitespacesAndNewlines),
                  !resolvedPath.isEmpty,
                  let normalizedPath = SkillBinTrust.normalizeResolvedPath(resolvedPath, processCwd: processCwd)
        else { return false }
        return trust[executableName]?.contains(normalizedPath) == true
    }
}

/// Mirror of core `SkillBinTrustEntry` handling (name → set of normalized
/// resolved paths).
enum SkillBinTrust {
    struct Entry: Sendable {
        let name: String
        let resolvedPath: String
    }

    static func normalizeName(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return trimmed.isEmpty ? nil : trimmed
    }

    /// Lexical `path.resolve` equivalent: absolute, "."/".." collapsed against
    /// the injected process working directory.
    static func normalizeResolvedPath(
        _ value: String,
        processCwd: String = FileManager.default.currentDirectoryPath) -> String?
    {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if ExecPathScalars.isAbsolute(trimmed) {
            return ExecCommandResolution.collapsePath(trimmed)
        }
        let base = processCwd
        return ExecCommandResolution.collapsePath(
            ExecPathScalars.hasSuffix(base, "/") ? base + trimmed : base + "/" + trimmed)
    }

    static func buildIndex(
        _ entries: [Entry],
        processCwd: String = FileManager.default.currentDirectoryPath) -> [String: Set<String>]
    {
        var index: [String: Set<String>] = [:]
        for entry in entries {
            guard let name = normalizeName(entry.name),
                  let resolvedPath = normalizeResolvedPath(entry.resolvedPath, processCwd: processCwd)
            else { continue }
            index[name, default: []].insert(resolvedPath)
        }
        return index
    }
}
