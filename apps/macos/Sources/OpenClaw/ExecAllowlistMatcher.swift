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

    private static func matches(pattern: String, target: String) -> Bool {
        let trimmed = pattern.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        let expanded = ExecPathScalars.hasPrefix(trimmed, "~")
            ? (trimmed as NSString).expandingTildeInPath : trimmed
        let normalizedPattern = self.normalizeMatchTarget(expanded)
        let normalizedTarget = self.normalizeMatchTarget(target)
        return self.globMatch(pattern: normalizedPattern, target: normalizedTarget)
    }

    private static func normalizeMatchTarget(_ value: String) -> String {
        value.replacingOccurrences(of: "\\\\", with: "/").lowercased()
    }

    private enum GlobToken {
        case literal(UInt16)
        case anyUnit
        case anyRun(includingSlash: Bool)
    }

    /// Direct UTF-16 glob matcher with JavaScript non-unicode RegExp semantics,
    /// port of TS `compileGlobRegex` + `new RegExp(regex, "i")`
    /// (src/infra/exec-allowlist-pattern.ts): `*` matches any run of units
    /// excluding "/", `**` any run including "/", and `?` consumes exactly ONE
    /// UTF-16 unit — a supplementary code point is two units. ICU/NSRegularExpression
    /// gives `.` whole-scalar width, so it matches supplementary characters
    /// where the TS matcher does not (review U2).
    private static func globMatch(pattern: String, target: String) -> Bool {
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
        let targetUnits = Array(target.utf16)
        var deadEnds = Set<Int>()
        return self.matchGlob(tokens, 0, targetUnits, 0, &deadEnds)
    }

    /// Greedy backtracking match with memoized dead ends (same shape as the
    /// compiled TS regex: `*` → `[^/]*`, `**` → `.*`, `?` → `.` per unit).
    private static func matchGlob(
        _ tokens: [GlobToken],
        _ tokenIndex: Int,
        _ units: [UInt16],
        _ unitIndex: Int,
        _ deadEnds: inout Set<Int>) -> Bool
    {
        var ti = tokenIndex
        var ui = unitIndex
        while ti < tokens.count {
            switch tokens[ti] {
            case let .literal(expected):
                guard ui < units.count,
                      Self.jsCanonicalUnit(units[ui]) == Self.jsCanonicalUnit(expected)
                else { return false }
                ui += 1
                ti += 1
            case .anyUnit:
                guard ui < units.count else { return false }
                ui += 1
                ti += 1
            case let .anyRun(includingSlash):
                let key = ti * (units.count + 1) + ui
                if deadEnds.contains(key) { return false }
                var maxEnd = units.count
                if !includingSlash {
                    maxEnd = ui
                    while maxEnd < units.count, units[maxEnd] != 0x2F {
                        maxEnd += 1
                    }
                }
                var cursor = maxEnd
                while true {
                    if self.matchGlob(tokens, ti + 1, units, cursor, &deadEnds) { return true }
                    if cursor == ui { break }
                    cursor -= 1
                }
                deadEnds.insert(key)
                return false
            }
        }
        return ui == units.count
    }

    /// ECMAScript RegExp `i` canonicalization without the Unicode flag
    /// (Canonicalize): ToUpperCase of the unit's scalar when that mapping is
    /// still a single code unit, otherwise the unit itself.
    private static func jsCanonicalUnit(_ unit: UInt16) -> UInt16 {
        guard let scalar = Unicode.Scalar(unit) else { return unit } // lone surrogate: no case mapping
        let upper = String(scalar).uppercased()
        var iterator = upper.unicodeScalars.makeIterator()
        guard let first = iterator.next(), iterator.next() == nil, first.value <= 0xFFFF else {
            return unit
        }
        return UInt16(first.value)
    }
}
