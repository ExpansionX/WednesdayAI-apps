import Foundation
import Testing
@testable import OpenClaw

/// These cases cover optional `security=allowlist` behavior.
/// Default install posture remains deny-by-default for exec on macOS node-host.
struct ExecAllowlistTests {
    private struct ShellParserParityFixture: Decodable {
        struct Case: Decodable {
            let id: String
            let command: String
            let ok: Bool
            let executables: [String]
        }

        let cases: [Case]
    }

    private struct WrapperResolutionParityFixture: Decodable {
        struct Case: Decodable {
            let id: String
            let argv: [String]
            let expectedRawExecutable: String?
        }

        let cases: [Case]
    }

    private static func loadShellParserParityCases() throws -> [ShellParserParityFixture.Case] {
        let fixtureURL = self.fixtureURL(filename: "exec-allowlist-shell-parser-parity.json")
        let data = try Data(contentsOf: fixtureURL)
        let fixture = try JSONDecoder().decode(ShellParserParityFixture.self, from: data)
        return fixture.cases
    }

    private static func loadWrapperResolutionParityCases() throws -> [WrapperResolutionParityFixture.Case] {
        let fixtureURL = self.fixtureURL(filename: "exec-wrapper-resolution-parity.json")
        let data = try Data(contentsOf: fixtureURL)
        let fixture = try JSONDecoder().decode(WrapperResolutionParityFixture.self, from: data)
        return fixture.cases
    }

    private static func fixtureURL(filename: String) -> URL {
        var repoRoot = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 {
            repoRoot.deleteLastPathComponent()
        }
        return repoRoot
            .appendingPathComponent("apps")
            .appendingPathComponent("shared")
            .appendingPathComponent("contracts")
            .appendingPathComponent("fixtures")
            .appendingPathComponent(filename)
    }

    private static func homebrewRGResolution() -> ExecCommandResolution {
        ExecCommandResolution(
            rawExecutable: "rg",
            resolvedPath: "/opt/homebrew/bin/rg",
            executableName: "rg",
            cwd: nil)
    }

    @Test func `match uses resolved path`() {
        let entry = ExecAllowlistEntry(pattern: "/opt/homebrew/bin/rg")
        let resolution = Self.homebrewRGResolution()
        let match = ExecAllowlistMatcher.match(entries: [entry], resolution: resolution)
        #expect(match?.pattern == entry.pattern)
    }

    @Test func `match ignores basename pattern`() {
        let entry = ExecAllowlistEntry(pattern: "rg")
        let resolution = Self.homebrewRGResolution()
        let match = ExecAllowlistMatcher.match(entries: [entry], resolution: resolution)
        #expect(match == nil)
    }

    @Test func `match ignores basename for relative executable`() {
        let entry = ExecAllowlistEntry(pattern: "echo")
        let resolution = ExecCommandResolution(
            rawExecutable: "./echo",
            resolvedPath: "/tmp/oc-basename/echo",
            executableName: "echo",
            cwd: "/tmp/oc-basename")
        let match = ExecAllowlistMatcher.match(entries: [entry], resolution: resolution)
        #expect(match == nil)
    }

    @Test func `match is case insensitive`() {
        let entry = ExecAllowlistEntry(pattern: "/OPT/HOMEBREW/BIN/RG")
        let resolution = Self.homebrewRGResolution()
        let match = ExecAllowlistMatcher.match(entries: [entry], resolution: resolution)
        #expect(match?.pattern == entry.pattern)
    }

    @Test func `match supports glob star`() {
        let entry = ExecAllowlistEntry(pattern: "/opt/**/rg")
        let resolution = Self.homebrewRGResolution()
        let match = ExecAllowlistMatcher.match(entries: [entry], resolution: resolution)
        #expect(match?.pattern == entry.pattern)
    }

    @Test func `resolve for allowlist splits shell chains`() {
        let command = ["/bin/sh", "-lc", "echo allowlisted && /usr/bin/touch /tmp/openclaw-allowlist-test"]
        let resolutions = ExecCommandResolution.resolveForAllowlist(
            command: command,
            rawCommand: "echo allowlisted && /usr/bin/touch /tmp/openclaw-allowlist-test",
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(resolutions.count == 2)
        #expect(resolutions[0].executableName == "echo")
        #expect(resolutions[1].executableName == "touch")
    }

    @Test func `resolve for allowlist keeps quoted operators in single segment`() {
        let command = ["/bin/sh", "-lc", "echo \"a && b\""]
        let resolutions = ExecCommandResolution.resolveForAllowlist(
            command: command,
            rawCommand: "echo \"a && b\"",
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(resolutions.count == 1)
        #expect(resolutions[0].executableName == "echo")
    }

    @Test func `resolve for allowlist fails closed on command substitution`() {
        let command = ["/bin/sh", "-lc", "echo $(/usr/bin/touch /tmp/openclaw-allowlist-test-subst)"]
        let resolutions = ExecCommandResolution.resolveForAllowlist(
            command: command,
            rawCommand: "echo $(/usr/bin/touch /tmp/openclaw-allowlist-test-subst)",
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(resolutions.isEmpty)
    }

    @Test func `resolve for allowlist fails closed on quoted command substitution`() {
        let command = ["/bin/sh", "-lc", "echo \"ok $(/usr/bin/touch /tmp/openclaw-allowlist-test-quoted-subst)\""]
        let resolutions = ExecCommandResolution.resolveForAllowlist(
            command: command,
            rawCommand: "echo \"ok $(/usr/bin/touch /tmp/openclaw-allowlist-test-quoted-subst)\"",
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(resolutions.isEmpty)
    }

    @Test func `resolve for allowlist fails closed on quoted backticks`() {
        let command = ["/bin/sh", "-lc", "echo \"ok `/usr/bin/id`\""]
        let resolutions = ExecCommandResolution.resolveForAllowlist(
            command: command,
            rawCommand: "echo \"ok `/usr/bin/id`\"",
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(resolutions.isEmpty)
    }

    @Test func `resolve for allowlist matches shared shell parser fixture`() throws {
        let fixtures = try Self.loadShellParserParityCases()
        for fixture in fixtures {
            let resolutions = ExecCommandResolution.resolveForAllowlist(
                command: ["/bin/sh", "-lc", fixture.command],
                rawCommand: fixture.command,
                cwd: nil,
                env: ["PATH": "/usr/bin:/bin"])

            #expect(!resolutions.isEmpty == fixture.ok)
            if fixture.ok {
                let executables = resolutions.map { $0.executableName.lowercased() }
                let expected = fixture.executables.map { $0.lowercased() }
                #expect(executables == expected)
            }
        }
    }

    private struct WrapperPlanExpectation {
        let effectiveArgv: [String]
        let wrappers: [String]
        let policyBlocked: Bool
        let blockedWrapper: String?
        let resolvedPath: String?
        let resolvedRealPath: String?
    }

    /// Core-derived expectations (verified against
    /// `resolveDispatchWrapperExecutionPlan` at core HEAD) for every returned
    /// resolution field, keyed by fixture case id. Blocked plans pin effective
    /// argv to the outer invocation; transparent plans pin it to the wrapped
    /// command.
    private static let wrapperFixturePlanExpectations: [String: WrapperPlanExpectation] = [
        "direct-absolute-executable": WrapperPlanExpectation(
            effectiveArgv: ["/usr/bin/printf", "ok"],
            wrappers: [],
            policyBlocked: false,
            blockedWrapper: nil,
            resolvedPath: "/usr/bin/printf",
            resolvedRealPath: "/usr/bin/printf"),
        "env-assignment-prefix": WrapperPlanExpectation(
            effectiveArgv: ["/usr/bin/env", "FOO=bar", "/usr/bin/printf", "ok"],
            wrappers: ["env"],
            policyBlocked: true,
            blockedWrapper: "env",
            resolvedPath: "/usr/bin/env",
            resolvedRealPath: "/usr/bin/env"),
        "env-option-with-separate-value": WrapperPlanExpectation(
            effectiveArgv: ["/usr/bin/env", "-u", "HOME", "/usr/bin/printf", "ok"],
            wrappers: ["env"],
            policyBlocked: true,
            blockedWrapper: "env",
            resolvedPath: "/usr/bin/env",
            resolvedRealPath: "/usr/bin/env"),
        "env-option-with-inline-value": WrapperPlanExpectation(
            effectiveArgv: ["/usr/bin/env", "-uHOME", "/usr/bin/printf", "ok"],
            wrappers: ["env"],
            policyBlocked: true,
            blockedWrapper: "env",
            resolvedPath: "/usr/bin/env",
            resolvedRealPath: "/usr/bin/env"),
        "nested-env-wrappers": WrapperPlanExpectation(
            effectiveArgv: ["/usr/bin/env", "FOO=bar", "printf", "ok"],
            wrappers: ["env", "env"],
            policyBlocked: true,
            blockedWrapper: "env",
            resolvedPath: "/usr/bin/env",
            resolvedRealPath: "/usr/bin/env"),
        "env-shell-wrapper-stops-at-shell": WrapperPlanExpectation(
            effectiveArgv: ["bash", "-lc", "echo ok"],
            wrappers: ["env"],
            policyBlocked: false,
            blockedWrapper: nil,
            resolvedPath: "/bin/bash",
            resolvedRealPath: "/bin/bash"),
        "env-missing-effective-command": WrapperPlanExpectation(
            effectiveArgv: ["/usr/bin/env", "FOO=bar"],
            wrappers: [],
            policyBlocked: true,
            blockedWrapper: "env",
            resolvedPath: "/usr/bin/env",
            resolvedRealPath: "/usr/bin/env"),
    ]

    @Test func `resolve matches shared wrapper resolution fixture`() throws {
        let fixtures = try Self.loadWrapperResolutionParityCases()
        for fixture in fixtures {
            let resolution = ExecCommandResolution.resolve(
                command: fixture.argv,
                cwd: nil,
                env: ["PATH": "/usr/bin:/bin"])
            #expect(resolution?.rawExecutable == fixture.expectedRawExecutable)

            guard let expected = Self.wrapperFixturePlanExpectations[fixture.id] else {
                Issue.record("missing plan expectation for fixture \(fixture.id)")
                continue
            }
            #expect(resolution?.effectiveArgv == expected.effectiveArgv, "\(fixture.id): effectiveArgv")
            #expect(resolution?.wrapperChain == expected.wrappers, "\(fixture.id): wrapperChain")
            #expect(resolution?.policyBlocked == expected.policyBlocked, "\(fixture.id): policyBlocked")
            #expect(resolution?.blockedWrapper == expected.blockedWrapper, "\(fixture.id): blockedWrapper")
            #expect(resolution?.resolvedPath == expected.resolvedPath, "\(fixture.id): resolvedPath")
            #expect(resolution?.resolvedRealPath == expected.resolvedRealPath, "\(fixture.id): resolvedRealPath")
        }
    }

    @Test func `timeout without command fails closed`() {
        // F5: a failed duration adjustment rejects the unwrap — the plan stays
        // pinned to the timeout invocation and is policy-blocked.
        let plan = ExecDispatchWrapper.resolveDispatchWrapperExecutionPlan(["timeout", "10s"])
        #expect(plan.policyBlocked)
        #expect(plan.blockedWrapper == "timeout")
        #expect(plan.wrappers.isEmpty)
        #expect(plan.argv == ["timeout", "10s"])

        let resolution = ExecCommandResolution.resolve(
            command: ["timeout", "10s"],
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(resolution?.rawExecutable == "timeout")
        #expect(resolution?.policyBlocked == true)

        // Transparent timeout invocations still unwrap to the wrapped command.
        let transparent = ExecDispatchWrapper.resolveDispatchWrapperExecutionPlan(["timeout", "10", "printf", "ok"])
        #expect(!transparent.policyBlocked)
        #expect(transparent.argv == ["printf", "ok"])
        #expect(transparent.wrappers == ["timeout"])
    }

    @Test func `nice unicode digit flag is policy blocked`() {
        // F6: JavaScript \d is ASCII-only — a Unicode decimal digit after the
        // dash is an invalid nice flag, so the wrapper stays policy-blocked.
        let plan = ExecDispatchWrapper.resolveDispatchWrapperExecutionPlan([
            "nice",
            "-\u{0661}",
            "/usr/bin/printf",
            "ok",
        ])
        #expect(plan.policyBlocked)
        #expect(plan.blockedWrapper == "nice")
        #expect(plan.wrappers.isEmpty)
        #expect(plan.argv.first == "nice")

        // ASCII numeric priorities still unwrap transparently.
        let ascii = ExecDispatchWrapper.resolveDispatchWrapperExecutionPlan(["nice", "-1", "/usr/bin/printf", "ok"])
        #expect(!ascii.policyBlocked)
        #expect(ascii.argv == ["/usr/bin/printf", "ok"])
        #expect(ascii.wrappers == ["nice"])
    }

    @Test func `resolve for allowlist treats plain sh invocation as direct exec`() {
        let command = ["/bin/sh", "./script.sh"]
        let resolutions = ExecCommandResolution.resolveForAllowlist(
            command: command,
            rawCommand: nil,
            cwd: "/tmp",
            env: ["PATH": "/usr/bin:/bin"])
        #expect(resolutions.count == 1)
        #expect(resolutions[0].executableName == "sh")
    }

    @Test func `resolve for allowlist unwraps env shell wrapper chains`() {
        let command = [
            "/usr/bin/env",
            "/bin/sh",
            "-lc",
            "echo allowlisted && /usr/bin/touch /tmp/openclaw-allowlist-test",
        ]
        let resolutions = ExecCommandResolution.resolveForAllowlist(
            command: command,
            rawCommand: nil,
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(resolutions.count == 2)
        #expect(resolutions[0].executableName == "echo")
        #expect(resolutions[1].executableName == "touch")
    }

    @Test func `resolve for allowlist unwraps transparent env to effective direct executable`() {
        // A bare `env <command>` (no modifiers) is transparent: resolution targets
        // the wrapped executable.
        let command = ["/usr/bin/env", "/usr/bin/printf", "ok"]
        let resolutions = ExecCommandResolution.resolveForAllowlist(
            command: command,
            rawCommand: nil,
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(resolutions.count == 1)
        #expect(resolutions[0].resolvedPath == "/usr/bin/printf")
        #expect(resolutions[0].executableName == "printf")
        #expect(resolutions[0].wrapperChain == ["env"])
        #expect(!resolutions[0].policyBlocked)
    }

    @Test func `resolve for allowlist retains blocked env assignment segment`() {
        // Core parity (a1c4bf07 + segment retention): env assignments/flags are
        // semantic dispatch usage — the segment resolution is policyBlocked and
        // can never satisfy the allowlist, but it is retained so allow-always
        // persistence can derive the inner executable.
        let command = ["/usr/bin/env", "FOO=bar", "/usr/bin/printf", "ok"]
        let resolutions = ExecCommandResolution.resolveForAllowlist(
            command: command,
            rawCommand: nil,
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(resolutions.count == 1)
        #expect(resolutions[0].rawExecutable == "/usr/bin/env")
        #expect(resolutions[0].policyBlocked == true)
        #expect(resolutions[0].blockedWrapper == "env")

        let analysis = ExecCommandResolution.analyze(
            command: command,
            rawCommand: nil,
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(analysis.ok)
        #expect(analysis.shellCommand == nil)
        #expect(analysis.segments.count == 1)
        let outcome = ExecApprovalEvaluator.evaluatePolicy(
            security: .allowlist,
            shellCommand: analysis.shellCommand,
            analysis: analysis,
            allowlist: [ExecAllowlistEntry(pattern: "/usr/bin/printf")],
            autoAllowSkills: false,
            skillTrust: [],
            cwd: nil)
        #expect(!outcome.allowlistSatisfied)
        #expect(outcome.allowlistMatches.isEmpty)
        #expect(outcome.analysisOk)
        // Allow-always persistence derives the inner executable, not env.
        let patterns = ExecAllowlistPlan.allowAlwaysPatterns(
            segments: analysis.segments, cwd: nil, env: ["PATH": "/usr/bin:/bin"])
        #expect(patterns == ["/usr/bin/printf"])
    }

    @Test func `resolve for allowlist retains blocked dispatch wrappers`() {
        // sudo-style dispatch wrappers are policyBlocked, not silently dropped.
        let command = ["/usr/bin/sudo", "/usr/bin/printf", "ok"]
        let resolutions = ExecCommandResolution.resolveForAllowlist(
            command: command,
            rawCommand: nil,
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(resolutions.count == 1)
        #expect(resolutions[0].policyBlocked == true)
        #expect(resolutions[0].blockedWrapper == "sudo")
    }

    @Test func `planned argv executes the approved effective argv`() {
        // F1: a transparent wrapper (nohup) must not execute; the allowlist
        // approves /usr/bin/printf and the planned argv pins the resolved
        // executable before running.
        let command = ["/tmp/nohup", "/usr/bin/printf", "ok"]
        let analysis = ExecCommandResolution.analyze(
            command: command,
            rawCommand: nil,
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(analysis.ok)
        #expect(analysis.shellCommand == nil)
        #expect(analysis.segments.count == 1)
        let resolution = analysis.segments[0].resolution
        #expect(resolution?.rawExecutable == "/usr/bin/printf")
        #expect(resolution?.policyBlocked == false)
        #expect(resolution?.wrapperChain == ["nohup"])

        let outcome = ExecApprovalEvaluator.evaluatePolicy(
            security: .allowlist,
            shellCommand: analysis.shellCommand,
            analysis: analysis,
            allowlist: [ExecAllowlistEntry(pattern: "/usr/bin/printf")],
            autoAllowSkills: false,
            skillTrust: [],
            cwd: nil)
        #expect(outcome.allowlistSatisfied)

        switch ExecAllowlistPlan.plannedArgv(
            security: .allowlist,
            shellCommand: analysis.shellCommand,
            approvedByAsk: false,
            analysisOk: outcome.analysisOk,
            allowlistSatisfied: outcome.allowlistSatisfied,
            segments: analysis.segments)
        {
        case let .argv(argv):
            #expect(!argv.contains("/tmp/nohup"))
            // TS pins argv[0] to resolvedRealPath ?? resolvedPath — require the
            // realpath exactly, never the unpinned lookup string.
            #expect(argv[0] == resolution?.resolvedRealPath)
            #expect(argv.dropFirst() == ["ok"])
        case .none:
            Issue.record("expected planned argv")
        case .denied:
            Issue.record("expected planned argv, got denied")
        }

        // Policy-blocked plans deny instead of executing the wrapper chain.
        let blocked = ExecCommandResolution.resolve(
            command: ["/usr/bin/env", "FOO=bar", "/usr/bin/printf", "ok"],
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(blocked?.policyBlocked == true)
        if let blocked {
            let segment = ExecCommandSegment(
                raw: "env",
                argv: ["/usr/bin/env", "FOO=bar", "/usr/bin/printf", "ok"],
                resolution: blocked)
            if case .denied = ExecAllowlistPlan.plannedSegmentArgv(segment) {
                // expected deny
            } else {
                Issue.record("expected denied plan for policyBlocked segment")
            }
        }
    }

    @Test func `shell wrappers require approval under allowlist security`() {
        // F2: nice+env+shell wrapper recognition must force the mandatory
        // shell approval gate even when the inner executable matches.
        let command = [
            "/usr/bin/nice",
            "/usr/bin/env",
            "BASH_ENV=/tmp/payload.sh",
            "/bin/bash",
            "-c",
            "/usr/bin/printf ok",
        ]
        let analysis = ExecCommandResolution.analyze(
            command: command,
            rawCommand: nil,
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(analysis.ok)
        #expect(analysis.shellCommand == "/usr/bin/printf ok")

        let outcome = ExecApprovalEvaluator.evaluatePolicy(
            security: .allowlist,
            shellCommand: analysis.shellCommand,
            analysis: analysis,
            allowlist: [ExecAllowlistEntry(pattern: "/usr/bin/printf")],
            autoAllowSkills: false,
            skillTrust: [],
            cwd: nil)
        #expect(outcome.shellWrapperBlocked)
        #expect(!outcome.analysisOk)
        #expect(!outcome.allowlistSatisfied)
        #expect(!outcome.skillAllow)

        // Simpler newly-recognized class: nice before a plain shell wrapper.
        let simple = ExecCommandResolution.analyze(
            command: ["/usr/bin/nice", "/bin/sh", "-c", "echo ok"],
            rawCommand: nil,
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(simple.shellCommand == "echo ok")
        let simpleOutcome = ExecApprovalEvaluator.evaluatePolicy(
            security: .allowlist,
            shellCommand: simple.shellCommand,
            analysis: simple,
            allowlist: [ExecAllowlistEntry(pattern: "/bin/echo")],
            autoAllowSkills: false,
            skillTrust: [],
            cwd: nil)
        #expect(simpleOutcome.shellWrapperBlocked)
        #expect(!simpleOutcome.allowlistSatisfied)

        // Full security is unaffected by the shell gate.
        let fullOutcome = ExecApprovalEvaluator.evaluatePolicy(
            security: .full,
            shellCommand: analysis.shellCommand,
            analysis: analysis,
            allowlist: [],
            autoAllowSkills: false,
            skillTrust: [],
            cwd: nil)
        #expect(fullOutcome.analysisOk)
        #expect(!fullOutcome.shellWrapperBlocked)
    }

    @Test func `skill auto allow requires resolved path trust`() {
        // F4: path-scoped raw executables never skill-auto-allow even when the
        // bin name is registered; name-based trust must also match the
        // resolved path. The reviewer's scenario has /tmp/skill-bin executable
        // while the trusted entry points elsewhere.
        let dir = NSTemporaryDirectory() + "oc-skillbin-\(UUID().uuidString)"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let skillBinPath = URL(fileURLWithPath: dir).appendingPathComponent("skill-bin")
        let created = FileManager.default.createFile(
            atPath: skillBinPath.path,
            contents: Data("#!/bin/sh\nexit 0\n".utf8),
            attributes: [.posixPermissions: 0o755])
        #expect(created)
        defer { try? FileManager.default.removeItem(atPath: dir) }

        let command = ["/usr/bin/nice", skillBinPath.path, "--help"]
        let analysis = ExecCommandResolution.analyze(
            command: command,
            rawCommand: nil,
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(analysis.ok)
        let resolution = analysis.segments[0].resolution
        #expect(resolution?.executableName == "skill-bin")
        #expect(resolution?.rawExecutable == skillBinPath.path)

        let trustEntry = SkillBinTrust.Entry(name: "skill-bin", resolvedPath: "/opt/skills/skill-bin")
        let outcome = ExecApprovalEvaluator.evaluatePolicy(
            security: .allowlist,
            shellCommand: nil,
            analysis: analysis,
            allowlist: [],
            autoAllowSkills: true,
            skillTrust: [trustEntry],
            cwd: nil)
        #expect(!outcome.skillAllow)
        #expect(!outcome.allowlistSatisfied)
        let trust = SkillBinTrust.buildIndex([trustEntry])

        // Non-path-scoped invocation whose resolved path matches the trust
        // entry is allowed.
        let trusted = ExecCommandResolution(
            rawExecutable: "skill-bin",
            resolvedPath: "/opt/skills/skill-bin",
            executableName: "skill-bin",
            cwd: nil)
        let trustedSegment = ExecCommandSegment(
            raw: "skill-bin --help",
            argv: ["skill-bin", "--help"],
            resolution: trusted)
        #expect(ExecApprovalEvaluator.isSkillAutoAllowed(segment: trustedSegment, allowSkills: true, trust: trust))
        // A same-named binary at an untrusted path is rejected.
        let impostor = ExecCommandResolution(
            rawExecutable: "skill-bin",
            resolvedPath: "/tmp/skill-bin",
            executableName: "skill-bin",
            cwd: nil)
        let impostorSegment = ExecCommandSegment(raw: "skill-bin", argv: ["skill-bin"], resolution: impostor)
        #expect(!ExecApprovalEvaluator.isSkillAutoAllowed(segment: impostorSegment, allowSkills: true, trust: trust))
    }

    @Test func `planned argv pins the real path behind symlinks`() {
        // F12 residual: when the resolved path is a symlink, TS pins argv[0] to
        // the REAL path — dropping realpath pinning must fail this test.
        let dir = NSTemporaryDirectory() + "oc-symlink-\(UUID().uuidString)"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let real = URL(fileURLWithPath: dir).appendingPathComponent("real-printf")
        let link = URL(fileURLWithPath: dir).appendingPathComponent("link-printf")
        let created = FileManager.default.createFile(
            atPath: real.path,
            contents: Data("#!/bin/sh\nexit 0\n".utf8),
            attributes: [.posixPermissions: 0o755])
        #expect(created)
        try? FileManager.default.createSymbolicLink(at: link, withDestinationURL: real)
        defer { try? FileManager.default.removeItem(atPath: dir) }

        let command = [dir + "/nohup", link.path, "ok"]
        let analysis = ExecCommandResolution.analyze(
            command: command,
            rawCommand: nil,
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(analysis.ok)
        let resolution = analysis.segments[0].resolution
        #expect(resolution?.resolvedPath == link.path)
        let expectedReal = URL(fileURLWithPath: real.path).resolvingSymlinksInPath().path
        #expect(resolution?.resolvedRealPath == expectedReal)
        #expect(expectedReal != link.path)

        // The allowlist matches the resolved path (TS matchAllowlist semantics);
        // execution must then pin argv[0] to the REAL path behind the symlink.
        let outcome = ExecApprovalEvaluator.evaluatePolicy(
            security: .allowlist,
            shellCommand: nil,
            analysis: analysis,
            allowlist: [ExecAllowlistEntry(pattern: link.path)],
            autoAllowSkills: false,
            skillTrust: [],
            cwd: nil)
        #expect(outcome.allowlistSatisfied)

        guard case let .argv(argv) = ExecAllowlistPlan.plannedArgv(
            security: .allowlist,
            shellCommand: nil,
            approvedByAsk: false,
            analysisOk: outcome.analysisOk,
            allowlistSatisfied: outcome.allowlistSatisfied,
            segments: analysis.segments)
        else {
            Issue.record("expected planned argv")
            return
        }
        #expect(argv[0] == expectedReal)
        #expect(argv[0] != link.path)
        #expect(argv.dropFirst() == ["ok"])
    }

    @Test func `socket display binds to validated full argv on raw mismatch`() {
        // R1: the socket must forward the VALIDATED display text to the
        // approval surface. With a positional-carrier shell payload and an
        // unrelated client rawCommand, validation falls back to the full-argv
        // display; forwarding that value keeps the prompt authoritative while
        // analysis stays argv-derived.
        let command = ["/bin/sh", "-lc", "$0 \"$1\"", "/usr/bin/touch", "/tmp/marker"]

        // The validator rejects nothing but refuses the stale display text.
        guard case let .ok(validated) = ExecSystemRunCommandValidator.resolve(
            command: command,
            rawCommand: "printf safe")
        else {
            Issue.record("expected valid resolution")
            return
        }
        #expect(validated.displayCommand == "/bin/sh -lc \"$0 \\\"$1\\\"\" /usr/bin/touch /tmp/marker")
        #expect(validated.displayCommand != "printf safe")

        // Forwarding the validated display (as the socket now does) preserves
        // it through the display-only formatter; the prompt can never show the
        // stale client text.
        let promptDisplay = ExecCommandFormatter.displayString(for: command, rawCommand: validated.displayCommand)
        #expect(promptDisplay == validated.displayCommand)

        // Analysis remains argv-derived: the shell gate still binds display to
        // the full argv because positional carriers follow the inline payload.
        let analysis = ExecCommandResolution.analyze(
            command: command,
            rawCommand: validated.displayCommand,
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(analysis.shellCommand == "$0 \"$1\"")
        let outcome = ExecApprovalEvaluator.evaluatePolicy(
            security: .allowlist,
            shellCommand: analysis.shellCommand,
            analysis: analysis,
            allowlist: [ExecAllowlistEntry(pattern: "/usr/bin/touch")],
            autoAllowSkills: false,
            skillTrust: [],
            cwd: nil)
        #expect(outcome.shellWrapperBlocked)
        #expect(!outcome.allowlistSatisfied)
    }

    @Test func `relative cwd resolves against the process working directory`() {
        // R2: a relative request cwd must resolve against the injected process
        // working directory (path.resolve semantics) — not against the
        // filesystem root. The process cwd is injected so the test never
        // mutates shared process state.
        let dir = NSTemporaryDirectory() + "oc-relcwd-\(UUID().uuidString)"
        let toolsDir = URL(fileURLWithPath: dir).appendingPathComponent("project/tools")
        try? FileManager.default.createDirectory(at: toolsDir, withIntermediateDirectories: true)
        let script = toolsDir.appendingPathComponent("run")
        let created = FileManager.default.createFile(
            atPath: script.path,
            contents: Data("#!/bin/sh\nexit 0\n".utf8),
            attributes: [.posixPermissions: 0o755])
        #expect(created)
        defer { try? FileManager.default.removeItem(atPath: dir) }

        let expectedPath = dir + "/project/tools/run"
        let resolution = ExecCommandResolution.resolve(
            command: ["./tools/run"],
            cwd: "project",
            env: ["PATH": "/usr/bin:/bin"],
            processCwd: dir)
        #expect(resolution?.resolvedPath == expectedPath)
        #expect(resolution?.allowlistCandidatePath(cwd: "project", processCwd: dir) == expectedPath)

        // The reviewer's trap: only a root-level lookalike path is allowlisted.
        // The correct resolution must NOT match it, so approval is required.
        let analysis = ExecCommandResolution.analyze(
            command: ["./tools/run"],
            rawCommand: nil,
            cwd: "project",
            env: ["PATH": "/usr/bin:/bin"],
            processCwd: dir)
        let outcome = ExecApprovalEvaluator.evaluatePolicy(
            security: .allowlist,
            shellCommand: nil,
            analysis: analysis,
            allowlist: [ExecAllowlistEntry(pattern: "/project/tools/run")],
            autoAllowSkills: false,
            skillTrust: [],
            cwd: "project",
            processCwd: dir)
        #expect(!outcome.allowlistSatisfied)
    }

    @Test func `path join normalizes dot components without absolutizing`() {
        // R3: PATH joins normalize lexically like path.join while keeping
        // relative entries relative.
        #expect(ExecCommandResolution.joinPath("/usr/../bin", "echo") == "/bin/echo")
        #expect(ExecCommandResolution.joinPath("./tools", "run") == "tools/run")
        #expect(ExecCommandResolution.joinPath("tools//sub", "run") == "tools/sub/run")
        #expect(ExecCommandResolution.joinPath("/usr/bin/", "printf") == "/usr/bin/printf")
        #expect(ExecCommandResolution.joinPath("a/../b", "c") == "b/c")

        // Reviewer's end-to-end case: /usr/../bin resolves /bin/echo and a
        // /bin/echo allowlist entry matches the normalized candidate.
        let resolution = ExecCommandResolution.resolve(command: ["echo", "ok"], cwd: nil, env: ["PATH": "/usr/../bin"])
        #expect(resolution?.resolvedPath == "/bin/echo")
        let analysis = ExecCommandResolution.analyze(
            command: ["echo", "ok"],
            rawCommand: nil,
            cwd: nil,
            env: ["PATH": "/usr/../bin"])
        let outcome = ExecApprovalEvaluator.evaluatePolicy(
            security: .allowlist,
            shellCommand: nil,
            analysis: analysis,
            allowlist: [ExecAllowlistEntry(pattern: "/bin/echo")],
            autoAllowSkills: false,
            skillTrust: [],
            cwd: nil)
        #expect(outcome.allowlistSatisfied)
    }

    @Test func `allow always persistence never persists the shell`() {
        // F3/F7: allow-always derives entries from canonical analysis — the
        // shell itself is never persisted, inner executables are.
        let analysis = ExecCommandResolution.analyze(
            command: ["/bin/sh", "-lc", "/usr/bin/printf \"$1\"", "name", "ok"],
            rawCommand: nil,
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(analysis.ok)
        let patterns = ExecAllowlistPlan.allowAlwaysPatterns(
            segments: analysis.segments,
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(patterns == ["/usr/bin/printf"])
        #expect(!patterns.contains("/bin/sh"))
    }

    @Test func `unresolved relative candidate normalizes against cwd`() {
        // F8: a path-scoped raw executable whose file does not exist still
        // produces a cwd-normalized allowlist candidate.
        let dir = NSTemporaryDirectory() + "oc-candidate-\(UUID().uuidString)"
        let toolsDir = URL(fileURLWithPath: dir).appendingPathComponent("tools")
        try? FileManager.default.createDirectory(at: toolsDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: dir) }

        let resolution = ExecCommandResolution.resolve(
            command: ["./tools/run"],
            cwd: dir,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(resolution?.resolvedPath == nil)
        let candidate = resolution?.allowlistCandidatePath(cwd: dir)
        #expect(candidate == dir + "/tools/run")

        // A configured pattern matching the candidate satisfies the segment.
        let segment = ExecCommandSegment(raw: "./tools/run", argv: ["./tools/run"], resolution: resolution)
        let outcome = ExecApprovalEvaluator.evaluatePolicy(
            security: .allowlist,
            shellCommand: nil,
            analysis: ExecCommandAnalysis(ok: true, shellCommand: nil, segments: [segment]),
            allowlist: [ExecAllowlistEntry(pattern: dir + "/tools/run")],
            autoAllowSkills: false,
            skillTrust: [],
            cwd: dir)
        #expect(outcome.allowlistSatisfied)
    }

    @Test func `relative path entries keep relative candidate spelling`() {
        // F9: PATH candidates keep the PATH entry's spelling (relative stays
        // relative); existence checks resolve against the INJECTED process cwd
        // so the test never mutates shared process state.
        let dir = NSTemporaryDirectory() + "oc-relpath-\(UUID().uuidString)"
        let toolsDir = URL(fileURLWithPath: dir).appendingPathComponent("tools")
        try? FileManager.default.createDirectory(at: toolsDir, withIntermediateDirectories: true)
        let script = toolsDir.appendingPathComponent("run")
        let created = FileManager.default.createFile(
            atPath: script.path,
            contents: Data("#!/bin/sh\nexit 0\n".utf8),
            attributes: [.posixPermissions: 0o755])
        #expect(created)
        defer { try? FileManager.default.removeItem(atPath: dir) }

        let resolution = ExecCommandResolution.resolve(
            command: ["run"],
            cwd: nil,
            env: ["PATH": "tools"],
            processCwd: dir)
        #expect(resolution?.resolvedPath == "tools/run")
        #expect(resolution?.executableName == "run")
        // Realpath resolves the relative spelling against the injected cwd.
        let expectedReal = URL(fileURLWithPath: script.path).resolvingSymlinksInPath().path
        #expect(resolution?.resolvedRealPath == expectedReal)
    }

    @Test func `tokenizer preserves unicode content and js whitespace class`() {
        // F10: escapes consume per code unit — a combining scalar after the
        // backslash is consumed as the escaped character, not fused into a
        // grapheme that hides the backslash.
        let payload = "/usr/bin/printf \\\u{0301}x"
        let tokens = ExecShellArgvTokenizer.split(payload)
        #expect(tokens == ["/usr/bin/printf", "\u{0301}x"])

        // U+0085 NEXT LINE is not ECMAScript whitespace: one token.
        #expect(ExecShellArgvTokenizer.split("a\u{0085}b") == ["a\u{0085}b"])
        // U+FEFF BOM is ECMAScript whitespace: splits.
        #expect(ExecShellArgvTokenizer.split("a\u{FEFF}b") == ["a", "b"])
    }

    @Test func `combined c payload extraction uses utf16 offsets`() {
        // F11 input A: combining accent right after the c flag.
        let combined = ExecDispatchWrapper.resolveInlineCommandMatch(
            ["/bin/sh", "-c\u{0301}echo ok"],
            flags: ExecDispatchWrapper.posixInlineCommandFlags,
            allowCombinedC: true)
        #expect(combined.command == "\u{0301}echo ok")
        #expect(combined.valueTokenIndex == 1)

        let extraction = ExecDispatchWrapper.extractShellWrapperCommand(
            ["/bin/sh", "-c\u{0301}echo ok"],
            rawCommand: nil)
        #expect(extraction.isWrapper)
        #expect(extraction.command == "\u{0301}echo ok")

        // F11 input B: lowercasing İ lengthens the string; JS applies the
        // lowered index to the original token and returns "bc".
        let dotted = ExecDispatchWrapper.resolveInlineCommandMatch(
            ["sh", "-İcabc"],
            flags: ExecDispatchWrapper.posixInlineCommandFlags,
            allowCombinedC: true)
        #expect(dotted.command == "bc")
    }

    @Test func `match all requires every segment to match`() {
        let first = ExecCommandResolution(
            rawExecutable: "echo",
            resolvedPath: "/usr/bin/echo",
            executableName: "echo",
            cwd: nil)
        let second = ExecCommandResolution(
            rawExecutable: "/usr/bin/touch",
            resolvedPath: "/usr/bin/touch",
            executableName: "touch",
            cwd: nil)
        let resolutions = [first, second]

        let partial = ExecAllowlistMatcher.matchAll(
            entries: [ExecAllowlistEntry(pattern: "/usr/bin/echo")],
            resolutions: resolutions)
        #expect(partial.isEmpty)

        let full = ExecAllowlistMatcher.matchAll(
            entries: [ExecAllowlistEntry(pattern: "/USR/BIN/ECHO"), ExecAllowlistEntry(pattern: "/usr/bin/touch")],
            resolutions: resolutions)
        #expect(full.count == 2)
    }
}
