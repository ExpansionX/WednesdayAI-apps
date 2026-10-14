import Foundation
import Testing
@testable import OpenClaw

/// Round 6 (re-review 5) differential tests for the exec allowlist glob
/// matcher. Generated tables are produced by the harness named in each file's
/// header (node --import tsx /tmp/glob-parity-harness.mjs); every expectation
/// is the TypeScript reference result from
/// src/infra/exec-allowlist-pattern.ts at core 8a0cf07f.
struct ExecGlobParityTests {
    // MARK: - V1: non-ASCII units never canonicalize down to ASCII

    @Test func `dotless i literal does not match an ascii i allowlist entry`() {
        let dir = NSTemporaryDirectory() + "oc-glob-parity-\(UUID().uuidString)"
        defer { try? FileManager.default.removeItem(atPath: dir) }
        // The allowlisted entry is the ASCII literal; the argv uses U+0131.
        // TS keeps U+0131 out of the ASCII case fold, so the segment misses
        // and an on-miss ask is required.
        let analysis = ExecCommandResolution.analyze(
            command: ["/tmp/ma\u{0131}l"],
            rawCommand: nil,
            cwd: nil,
            env: nil,
            processCwd: dir)
        #expect(analysis.ok)
        let outcome = ExecApprovalEvaluator.evaluatePolicy(
            security: .allowlist,
            shellCommand: nil,
            analysis: analysis,
            allowlist: [ExecAllowlistEntry(pattern: "/tmp/mail")],
            autoAllowSkills: false,
            skillTrust: [],
            cwd: nil)
        #expect(!outcome.allowlistSatisfied)
        #expect(!outcome.skillAllow)
        #expect(ExecApprovalHelpers.requiresAsk(
            ask: .onMiss,
            security: .allowlist,
            allowlistMatch: outcome.allowlistMatches.first,
            skillAllow: outcome.skillAllow))

        // ASCII I/i positive control: the same entry matches ASCII inputs
        // case-insensitively.
        let ascii = ExecCommandResolution.analyze(
            command: ["/tmp/mail"],
            rawCommand: nil,
            cwd: nil,
            env: nil,
            processCwd: dir)
        let asciiOutcome = ExecApprovalEvaluator.evaluatePolicy(
            security: .allowlist,
            shellCommand: nil,
            analysis: ascii,
            allowlist: [ExecAllowlistEntry(pattern: "/tmp/Mail")],
            autoAllowSkills: false,
            skillTrust: [],
            cwd: nil)
        #expect(asciiOutcome.allowlistSatisfied)

        // Other non-ASCII units that uppercase INTO ASCII stay unmatched too
        // (U+017F long s; TS-verified false both directions).
        #expect(!ExecAllowlistMatcher.matches(pattern: "/tmp/ſ", target: "/tmp/s"))
        #expect(!ExecAllowlistMatcher.matches(pattern: "/tmp/s", target: "/tmp/ſ"))
        // U+212A KELVIN SIGN lowercases to ASCII k during normalization on
        // both sides, so those DO match (TS-verified true).
        #expect(ExecAllowlistMatcher.matches(pattern: "/tmp/k", target: "/tmp/K"))
        #expect(ExecAllowlistMatcher.matches(pattern: "/tmp/K", target: "/tmp/k"))
        // U+0130 canonicalizes to itself (single-unit uppercase, non-ASCII).
        #expect(ExecAllowlistMatcher.matches(pattern: "/tmp/\u{0130}x", target: "/tmp/\u{0130}x"))
    }

    // MARK: - V2: dot-derived tokens never consume JS line terminators

    @Test func `dot derived tokens never consume js line terminators`() {
        // `?` (dot) and `**` (dot-star) must reject exactly LF, CR, LS, PS.
        for terminator in ["\n", "\r", "\u{2028}", "\u{2029}"] {
            #expect(!ExecAllowlistMatcher.matches(pattern: "/tmp/?a", target: "/tmp/\(terminator)a"))
            #expect(!ExecAllowlistMatcher.matches(pattern: "/tmp/**/run", target: "/tmp/a\(terminator)b/run"))
        }
        // U+000B, U+000C and U+0085 are NOT JS line terminators: dot matches.
        for matchable in ["\u{000B}", "\u{000C}", "\u{0085}"] {
            #expect(ExecAllowlistMatcher.matches(pattern: "/tmp/?a", target: "/tmp/\(matchable)a"))
        }
        // Single star compiles to [^/]* — a negated class that intentionally
        // consumes line terminators — and literals match them verbatim.
        #expect(ExecAllowlistMatcher.matches(pattern: "/tmp/*", target: "/tmp/a\nb"))
        #expect(ExecAllowlistMatcher.matches(pattern: "/tmp/a\n*b", target: "/tmp/a\nxb"))
        #expect(ExecAllowlistMatcher.matches(pattern: "/tmp/a\nb", target: "/tmp/a\nb"))
    }

    // MARK: - V3: long patterns match iteratively (no native stack growth)

    @Test func `long separated wildcard patterns return without stack growth`() {
        let repetitions = 100_000
        let pattern = "/tmp/" + String(repeating: "*/", count: repetitions) + "*"
        let positive = "/tmp/" + String(repeating: "a/", count: repetitions) + "x"
        #expect(ExecAllowlistMatcher.matches(pattern: pattern, target: positive))

        // Negative: the trailing literal mismatch forces every star to
        // backtrack; still returns a plain false.
        let negative = "/tmp/" + String(repeating: "a/", count: repetitions) + "y/"
        #expect(!ExecAllowlistMatcher.matches(pattern: pattern, target: negative))

        // Wide single-star backtracking (heap frames, bounded work).
        let wideTarget = "/tmp/" + String(repeating: "a", count: 4_000)
        #expect(ExecAllowlistMatcher.matches(pattern: "/tmp/a*a", target: wideTarget))
        #expect(!ExecAllowlistMatcher.matches(pattern: "/tmp/*a*b", target: wideTarget))
    }

    @Test func `ambiguous many star late failure stays polynomial`() {
        // Reviewer W1 vector (46 units): without the failed-state set this
        // visits C(40, 20) suffix explorations before returning false.
        let clock = ContinuousClock()
        let latePattern = "/tmp/" + String(repeating: "*a", count: 20) + "b"
        var start = clock.now
        #expect(!ExecAllowlistMatcher.matches(
            pattern: latePattern,
            target: "/tmp/" + String(repeating: "a", count: 40) + "c"))
        #expect((clock.now - start) < .seconds(1))

        // Positive control: the reachable final literal still matches.
        #expect(ExecAllowlistMatcher.matches(
            pattern: latePattern,
            target: "/tmp/" + String(repeating: "a", count: 40) + "b"))

        // Scaled well past 200 units, miss and hit, still inside the bound.
        let scaledPattern = "/tmp/" + String(repeating: "*a", count: 120) + "b"
        start = clock.now
        #expect(!ExecAllowlistMatcher.matches(
            pattern: scaledPattern,
            target: "/tmp/" + String(repeating: "a", count: 240) + "c"))
        #expect(ExecAllowlistMatcher.matches(
            pattern: scaledPattern,
            target: "/tmp/" + String(repeating: "a", count: 240) + "b"))
        #expect((clock.now - start) < .seconds(1))
    }

    // MARK: - Generated differential vectors (TypeScript ground truth)

    @Test func `generated glob vectors agree with the typescript reference`() {
        var failures: [String] = []
        for vector in ExecGlobParityVectors.all {
            let actual = ExecAllowlistMatcher.matches(pattern: vector.pattern, target: vector.target)
            if actual != vector.expected {
                failures.append("\(vector.pattern) vs \(vector.target): expected \(vector.expected), got \(actual)")
            }
        }
        #expect(failures.isEmpty, "\(failures.prefix(5))")
        #expect(ExecGlobParityVectors.all.count >= 500)
    }

    @Test func `canonicalize agrees with the javascript reference over every unit`() {
        var mismatched = Set<UInt16>()
        var failures: [String] = []
        for entry in ExecGlobCanonicalizeTable.entries {
            mismatched.insert(entry.unit)
            let actual = ExecAllowlistMatcher.jsCanonicalUnit(entry.unit)
            if actual != entry.canonical {
                failures
                    .append(
                        "U+\(String(entry.unit, radix: 16)): expected U+\(String(entry.canonical, radix: 16)), got U+\(String(actual, radix: 16))")
            }
        }
        // Every unit absent from the table must canonicalize to itself.
        for value: UInt32 in 0...0xFFFF {
            let unit = UInt16(value)
            guard !mismatched.contains(unit) else { continue }
            if ExecAllowlistMatcher.jsCanonicalUnit(unit) != unit {
                failures.append("U+\(String(unit, radix: 16)): expected identity")
            }
        }
        #expect(failures.isEmpty, "\(failures.prefix(5))")
    }
}
