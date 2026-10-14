import Foundation
import Testing
@testable import OpenClaw

/// Review T1 plus the round-4 class audit: exec path and argv classification
/// must follow the TypeScript/Node UTF-16 code-unit semantics, not Swift
/// grapheme clusters. A leading "/" followed by a combining scalar (U+0301) is
/// one Character in Swift, so byte-level (0x2F) root detection is required to
/// keep collapsePath, PATH lookup, check-path/realpath construction and
/// allowlist/plan candidates consistent with the reference. Every test injects
/// `processCwd`; the process working directory and environment are never
/// mutated.
struct ExecPathScalarTests {
    private static func makeTempDirectory(_ label: String) -> String {
        let dir = NSTemporaryDirectory() + "\(label)-\(UUID().uuidString)"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        return dir
    }

    private static func makeExecutable(at path: String) -> Bool {
        FileManager.default.createFile(
            atPath: path,
            contents: Data("#!/bin/sh\nexit 0\n".utf8),
            attributes: [.posixPermissions: 0o755])
    }

    // MARK: - T1 reviewer input A (pure normalization)

    @Test func `accented root stays absolute through join and collapse`() {
        // "/" + U+0301 is one Character; grapheme hasPrefix("/") classified the
        // path relative and dropped the root after scalar component splitting.
        #expect(ExecPathScalars.isAbsolute("/\u{0301}dir"))
        #expect(!ExecPathScalars.isAbsolute("x/\u{0301}dir"))
        #expect(!ExecPathScalars.isAbsolute(""))
        #expect(ExecCommandResolution.joinPath("/\u{0301}dir", "run") == "/\u{0301}dir/run")
        #expect(ExecCommandResolution.collapsePath("/\u{0301}dir/./run") == "/\u{0301}dir/run")
        #expect(ExecCommandResolution.collapsePath("/\u{0301}dir/../keep") == "/keep")
    }

    // MARK: - T1 root-missing / process-directory-lookalike scenario

    @Test func `process directory lookalike does not satisfy an accented root PATH entry`() {
        let dir = Self.makeTempDirectory("oc-exec-scalar-root")
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let accentChild = dir + "/\u{0301}dir"
        try? FileManager.default.createDirectory(atPath: accentChild, withIntermediateDirectories: true)
        #expect(Self.makeExecutable(at: accentChild + "/run"))

        // PATH entry spells an absolute accented root. The root-level target
        // does not exist; only the process-directory lookalike does. TS probes
        // the root-level candidate and leaves `run` unresolved.
        let candidate = ExecCommandResolution.resolveExecutableFromPathEnv(
            "run",
            pathEnv: "/\u{0301}dir",
            processCwd: dir)
        #expect(candidate == nil)

        let resolution = ExecCommandResolution.resolve(
            command: ["run"],
            cwd: nil,
            env: ["PATH": "/\u{0301}dir"],
            processCwd: dir)
        #expect(resolution?.resolvedPath == nil)

        // The relative pattern would have matched the pre-fix relative
        // candidate; with the root preserved it must not match anything.
        let analysis = ExecCommandResolution.resolveForAllowlist(
            command: ["run"],
            rawCommand: nil,
            cwd: nil,
            env: ["PATH": "/\u{0301}dir"],
            processCwd: dir)
        let matched = ExecAllowlistMatcher.match(
            entries: [ExecAllowlistEntry(pattern: "\u{0301}dir/run")],
            resolution: analysis.first)
        #expect(matched == nil)
    }

    @Test func `absolute accented argv does not fall back to the process directory`() {
        let dir = Self.makeTempDirectory("oc-exec-scalar-argv")
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let accentChild = dir + "/\u{0301}dir"
        try? FileManager.default.createDirectory(atPath: accentChild, withIntermediateDirectories: true)
        #expect(Self.makeExecutable(at: accentChild + "/run"))

        // A grapheme-root check misroutes this to the existing lookalike under
        // processCwd; the byte check probes the root-level path (missing).
        let resolution = ExecCommandResolution.resolve(
            command: ["/\u{0301}dir/run"],
            cwd: nil,
            env: ["PATH": ""],
            processCwd: dir)
        #expect(resolution?.resolvedPath == nil)
        #expect(resolution?.resolvedRealPath == nil)
        // Candidate fallback normalizes against cwd but must keep the root.
        #expect(resolution?.allowlistCandidatePath(cwd: nil, processCwd: dir) == "/\u{0301}dir/run")
    }

    @Test func `resolve against base keeps an accented absolute base rooted`() {
        let dir = Self.makeTempDirectory("oc-exec-scalar-base")
        defer { try? FileManager.default.removeItem(atPath: dir) }
        #expect(
            ExecCommandResolution.resolveAgainstBase("/\u{0301}dir", "tool", processCwd: dir) == "/\u{0301}dir/tool")
        // Relative bases still resolve against the injected process directory.
        #expect(ExecCommandResolution.resolveAgainstBase("proj", "x", processCwd: dir) == dir + "/proj/x")
    }

    // MARK: - Token normalization (basename, .exe strip)

    @Test func `basename lower handles fused separators and exe suffix`() {
        // TS basenameLower maps backslashes and splits on "/" per code unit; a
        // grapheme split missed the fused "\" and kept the directory prefix.
        #expect(ExecDispatchWrapper.basenameLower("dir\\\u{0301}tool") == "\u{0301}tool")
        // basenameLower keeps the extension; normalizeExecutableToken strips it.
        #expect(ExecDispatchWrapper.basenameLower("/\u{0301}dir/TOOL.EXE") == "tool.exe")
        #expect(ExecDispatchWrapper.normalizeExecutableToken("/usr/bin/Env.exe") == "env")
    }

    // MARK: - Dispatch wrapper option scanners

    @Test func `fused dash flag blocks nice`() {
        // TS startsWith("-") sees the dash; nice then rejects the flag and the
        // plan is policy-blocked. A grapheme check treated it as the command.
        let plan = ExecDispatchWrapper.resolveDispatchWrapperExecutionPlan(["nice", "-\u{0301}", "run"])
        #expect(plan.policyBlocked)
        #expect(plan.blockedWrapper == "nice")
        #expect(plan.argv == ["nice", "-\u{0301}", "run"])
    }

    @Test func `fused dash n flag still unwraps nice`() {
        // TS startsWith("-n") && length > 2 (UTF-16); grapheme prefix missed
        // the flag and grapheme count disagreed with code-unit length.
        let plan = ExecDispatchWrapper.resolveDispatchWrapperExecutionPlan(["nice", "-n\u{0301}", "run"])
        #expect(!plan.policyBlocked)
        #expect(plan.wrappers == ["nice"])
        #expect(plan.argv == ["run"])
    }

    @Test func `fused equals keeps nice value option transparent`() {
        // TS flag = lower.split("=", 2)[0] and lower.includes("=") operate per
        // code unit; grapheme splitting fused "=" with the accent, failed the
        // inline-value check and blocked the wrapper instead of unwrapping.
        let plan = ExecDispatchWrapper.resolveDispatchWrapperExecutionPlan([
            "nice", "--adjustment=\u{0301}5", "run",
        ])
        #expect(!plan.policyBlocked)
        #expect(plan.wrappers == ["nice"])
        #expect(plan.argv == ["run"])
    }

    @Test func `fused equals keeps env option scanning per code unit`() {
        // The env unwrap must recognize "--ignore-signal=<accent>x" as a
        // consumed option (TS-verified: wrappers ["env"], semantic modifier
        // usage blocks with the outer argv pinned and blockedWrapper "env").
        // A grapheme split/prefix check failed the option scan (wrappers []).
        let plan = ExecDispatchWrapper.resolveDispatchWrapperExecutionPlan([
            "env", "--ignore-signal=\u{0301}x", "run",
        ])
        #expect(plan.policyBlocked)
        #expect(plan.blockedWrapper == "env")
        #expect(plan.wrappers == ["env"])
        #expect(plan.argv == ["env", "--ignore-signal=\u{0301}x", "run"])
    }

    // MARK: - Shell chain splitting

    @Test func `chain splitter respects quotes fused with combining scalars`() {
        let dir = Self.makeTempDirectory("oc-exec-scalar-chain")
        defer { try? FileManager.default.removeItem(atPath: dir) }
        // The opening "'" fuses with the following U+0301 into one Character;
        // grapheme iteration never opened the quote, the "|" split the chain
        // and the trailing quote left the split unterminated (fail closed).
        let analysis = ExecCommandResolution.analyze(
            command: ["/bin/sh", "-c", "echo '\u{0301}a|b'"],
            rawCommand: nil,
            cwd: nil,
            env: nil,
            processCwd: dir)
        #expect(analysis.ok)
        #expect(analysis.segments.count == 1)
    }

    // MARK: - Display formatting

    @Test func `formatter quotes per ECMAScript whitespace and fused quotes`() {
        // TS /\s|"/: U+0085 is NOT whitespace (no quoting), U+FEFF IS
        // (quoting); Character.isWhitespace is exactly reversed. A '"'
        // followed by U+0301 fused into one Character and skipped detection.
        #expect(ExecCommandFormatter.displayString(for: ["a\u{0085}b"]) == "a\u{0085}b")
        #expect(ExecCommandFormatter.displayString(for: ["a\u{FEFF}b"]) == "\"a\u{FEFF}b\"")
        #expect(ExecCommandFormatter.displayString(for: ["x\"\u{0301}y"]) == "\"x\\\"\u{0301}y\"")
        #expect(ExecCommandFormatter.displayString(for: ["a b"]) == "\"a b\"")
    }

    // MARK: - Skill trust

    @Test func `skill trust rejects fused path-scoped raw executable`() {
        let dir = Self.makeTempDirectory("oc-exec-scalar-skill")
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let trust = SkillBinTrust.buildIndex(
            [SkillBinTrust.Entry(name: "tool", resolvedPath: dir + "/tool")],
            processCwd: dir)
        let resolution = ExecCommandResolution(
            rawExecutable: "x/\u{0301}tool",
            resolvedPath: dir + "/tool",
            executableName: "tool",
            cwd: nil)
        let segment = ExecCommandSegment(raw: "x/\u{0301}tool", argv: ["x/\u{0301}tool"], resolution: resolution)
        // TS isPathScopedExecutableToken sees the "/" per code unit and rejects
        // before name trust; the grapheme check let it through.
        #expect(!ExecApprovalEvaluator.isSkillAutoAllowed(
            segment: segment,
            allowSkills: true,
            trust: trust,
            processCwd: dir))
    }

    @Test func `skill trust normalization keeps accented absolute path rooted`() {
        let dir = Self.makeTempDirectory("oc-exec-scalar-trust")
        defer { try? FileManager.default.removeItem(atPath: dir) }
        #expect(SkillBinTrust.normalizeResolvedPath("/\u{0301}dir/tool", processCwd: dir) == "/\u{0301}dir/tool")
        #expect(SkillBinTrust.normalizeResolvedPath("tools/tool", processCwd: dir) == dir + "/tools/tool")
    }

    // MARK: - Allowlist pattern classification and glob compilation

    @Test func `allowlist patterns with fused separators validate and match`() {
        // A pattern separator fused with a combining scalar failed the
        // hasPath check and was discarded before matching.
        let resolution = ExecCommandResolution(
            rawExecutable: "run",
            resolvedPath: "tools/\u{0301}run",
            executableName: "run",
            cwd: nil)
        let matched = ExecAllowlistMatcher.match(
            entries: [ExecAllowlistEntry(pattern: "tools/\u{0301}run")],
            resolution: resolution)
        #expect(matched != nil)
        #expect(matched?.pattern == "tools/\u{0301}run")
    }

    @Test func `wildcards stay wildcards after combining scalars`() {
        // TS compileGlobRegex iterates code units: "*" then U+0301 is a
        // wildcard followed by a literal accent. Grapheme iteration escaped the
        // fused "*\u{0301}" cluster as a literal, so nothing matched.
        let resolution = ExecCommandResolution(
            rawExecutable: "run",
            resolvedPath: "tools/x\u{0301}a",
            executableName: "run",
            cwd: nil)
        let matched = ExecAllowlistMatcher.match(
            entries: [ExecAllowlistEntry(pattern: "tools/*\u{0301}a")],
            resolution: resolution)
        #expect(matched != nil)
    }
}
