import Foundation

enum ExecAllowlistMatcher {
    static func match(entries: [ExecAllowlistEntry], resolution: ExecCommandResolution?) -> ExecAllowlistEntry? {
        guard let resolution, !entries.isEmpty else { return nil }
        let rawExecutable = resolution.rawExecutable
        let resolvedPath = resolution.resolvedPath

        for entry in entries {
            switch ExecApprovalHelpers.validateAllowlistPattern(entry.pattern) {
            case let .valid(pattern):
                let target = resolvedPath ?? rawExecutable
                if self.matches(pattern: pattern, target: target) { return entry }
            case .invalid:
                continue
            }
        }
        return nil
    }

    static func matchAll(
        entries: [ExecAllowlistEntry],
        resolutions: [ExecCommandResolution]) -> [ExecAllowlistEntry]
    {
        guard !entries.isEmpty, !resolutions.isEmpty else { return [] }
        var matches: [ExecAllowlistEntry] = []
        matches.reserveCapacity(resolutions.count)
        for resolution in resolutions {
            guard let match = self.match(entries: entries, resolution: resolution) else {
                return []
            }
            matches.append(match)
        }
        return matches
    }

    /// Full TS `matchesExecAllowlistPattern` pipeline (trim → tilde → lowercase
    /// normalize → glob match); internal for the generated parity tests.
    static func matches(pattern: String, target: String) -> Bool {
        self.matchCountingStates(pattern: pattern, target: target).matched
    }

    /// Identical pipeline, also returning how many distinct `(token, input)`
    /// states the matcher actually walked (internal test seam, round 7b).
    /// Because every failed walk memoizes its state, this is bounded by
    /// `(pattern units + 1) * (target units + 1)` — the pre-W1 uncached search
    /// re-walked states under different prefix histories and exceeded that
    /// bound. Production callers pay one integer increment per walked state.
    static func matchCountingStates(pattern: String, target: String) -> (matched: Bool, exploredStates: Int) {
        let trimmed = pattern.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return (false, 0) }
        let expanded = ExecPathScalars.hasPrefix(trimmed, "~")
            ? (trimmed as NSString).expandingTildeInPath : trimmed
        return Self.globMatch(pattern: Self.normalizeMatchTarget(expanded), target: Self.normalizeMatchTarget(target))
    }

    private static func normalizeMatchTarget(_ value: String) -> String {
        value.replacingOccurrences(of: "\\\\", with: "/").lowercased()
    }

    private enum GlobToken {
        case literal(UInt16)
        case anyUnit
        case anyRun(includingSlash: Bool)
    }

    /// The JS line terminators (V2): with no `s` flag, `.` and `.*` never
    /// consume these; `[^/]*` is a negated class and does. Exactly these four —
    /// U+000B/U+000C/U+0085 remain dot-matchable, so CharacterSet-based
    /// whitespace sets must not be substituted.
    private static func isLineTerminator(_ unit: UInt16) -> Bool {
        unit == 0x000A || unit == 0x000D || unit == 0x2028 || unit == 0x2029
    }

    /// Token scan of TS `compileGlobRegex` (src/infra/exec-allowlist-pattern.ts):
    /// adjacent `**` pair groups into a slash-crossing run, a single `*` is a
    /// run excluding "/", `?` is one unit, everything else is a literal
    /// (regex-metacharacter escaping has no effect on a direct matcher).
    private static func compileGlobTokens(_ pattern: String) -> [GlobToken] {
        var tokens: [GlobToken] = []
        tokens.reserveCapacity(pattern.utf16.count)
        let units = Array(pattern.utf16)
        var idx = 0
        while idx < units.count {
            let unit = units[idx]
            if unit == 0x2A { // "*"
                if idx + 1 < units.count, units[idx + 1] == 0x2A {
                    tokens.append(.anyRun(includingSlash: true))
                    idx += 2
                } else {
                    tokens.append(.anyRun(includingSlash: false))
                    idx += 1
                }
                continue
            }
            if unit == 0x3F { // "?"
                tokens.append(.anyUnit)
                idx += 1
                continue
            }
            tokens.append(.literal(unit))
            idx += 1
        }
        return tokens
    }

    /// Farthest unit index a star run may consume (greedy upper bound): `.*`
    /// (`**`) crosses "/" but stops before JS line terminators; `[^/]*` (`*`)
    /// stops before "/" and consumes line terminators.
    private static func starMaxEnd(
        includingSlash: Bool,
        units: [UInt16],
        _ from: Int) -> Int
    {
        var end = from
        if includingSlash {
            while end < units.count, !Self.isLineTerminator(units[end]) {
                end += 1
            }
        } else {
            while end < units.count, units[end] != 0x2F {
                end += 1
            }
        }
        return end
    }

    /// Direct UTF-16 glob matcher with JavaScript non-unicode RegExp semantics,
    /// port of TS `compileGlobRegex` + `new RegExp(regex, "i")`
    /// (src/infra/exec-allowlist-pattern.ts): `*` matches any run of units
    /// excluding "/", `**` any run including "/" but no line terminator, and
    /// `?` consumes exactly ONE UTF-16 unit that is not a line terminator — a
    /// supplementary code point is two units. Backtracking is iterative (V3):
    /// an explicit heap frame stack retries each star one unit shorter on
    /// failure, so pattern length never grows the native call stack. A
    /// failed-state set (W1) keyed by `(token index, input index)` — star
    /// starts are recorded when their frame is exhausted, segment starts when
    /// their deterministic walk dies — bounds the search to polynomially many
    /// states, so ambiguous late-failure inputs cannot re-explore a suffix
    /// under a different prefix history.
    private static func globMatch(pattern: String, target: String) -> (matched: Bool, exploredStates: Int) {
        let tokens = Self.compileGlobTokens(pattern)
        let units = Array(target.utf16)
        let stride = units.count + 1
        var tokenIndex = 0
        var unitIndex = 0
        var frames: [(star: Int, min: Int, end: Int)] = []
        var deadStates = Set<Int>()
        var exploredStates = 0
        while true {
            let walkStartKey = tokenIndex * stride + unitIndex
            var dead = deadStates.contains(walkStartKey)
            if !dead {
                // Each state is walked at most once (a failed walk memoizes
                // it), so this counter is bounded by the state space.
                exploredStates += 1
            }
            while tokenIndex < tokens.count, !dead {
                switch tokens[tokenIndex] {
                case let .literal(expected):
                    if unitIndex < units.count,
                       Self.jsCanonicalUnit(units[unitIndex]) == Self.jsCanonicalUnit(expected)
                    {
                        unitIndex += 1
                        tokenIndex += 1
                    } else {
                        dead = true
                    }
                case .anyUnit:
                    if unitIndex < units.count, !Self.isLineTerminator(units[unitIndex]) {
                        unitIndex += 1
                        tokenIndex += 1
                    } else {
                        dead = true
                    }
                case let .anyRun(includingSlash):
                    // The star's start state was already proven unable to reach
                    // a match (its frame was exhausted earlier): fail fast.
                    let starKey = tokenIndex * stride + unitIndex
                    if deadStates.contains(starKey) {
                        dead = true
                        break
                    }
                    let end = Self.starMaxEnd(includingSlash: includingSlash, units: units, unitIndex)
                    frames.append((star: tokenIndex, min: unitIndex, end: end))
                    tokenIndex += 1
                    unitIndex = end
                }
            }
            if !dead, unitIndex == units.count {
                return (true, exploredStates)
            }
            // This walk cannot succeed from its start; remember it.
            deadStates.insert(walkStartKey)
            // Backtrack: retry the newest star one unit shorter; discard it
            // once its run is empty, recording that its start state is dead
            // so no other prefix history re-descends it (W1).
            while true {
                guard var frame = frames.last else { return (false, exploredStates) }
                if frame.end > frame.min {
                    frame.end -= 1
                    frames[frames.count - 1] = frame
                    tokenIndex = frame.star + 1
                    unitIndex = frame.end
                    break
                }
                deadStates.insert(frame.star * stride + frame.min)
                frames.removeLast()
            }
        }
    }

    /// ECMAScript RegExp `i` canonicalization without the Unicode flag
    /// (Canonicalize, ECMA-262 22.2.2.7.3): ToUpperCase of the unit's scalar
    /// when that mapping is still a single code unit, else the unit itself;
    /// and a non-ASCII unit is never canonicalized down to an ASCII unit
    /// (V1: U+0131 stays U+0131 and does not match ASCII i).
    static func jsCanonicalUnit(_ unit: UInt16) -> UInt16 {
        guard let scalar = Unicode.Scalar(unit) else { return unit } // lone surrogate: no case mapping
        let upper = String(scalar).uppercased()
        var iterator = upper.unicodeScalars.makeIterator()
        guard let first = iterator.next(), iterator.next() == nil, first.value <= 0xFFFF else {
            return unit
        }
        if unit >= 0x80, first.value < 0x80 {
            return unit
        }
        return UInt16(first.value)
    }
}
