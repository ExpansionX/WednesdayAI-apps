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
        guard let regex = self.regex(for: normalizedPattern) else { return false }
        let range = NSRange(location: 0, length: normalizedTarget.utf16.count)
        return regex.firstMatch(in: normalizedTarget, options: [], range: range) != nil
    }

    private static func normalizeMatchTarget(_ value: String) -> String {
        value.replacingOccurrences(of: "\\\\", with: "/").lowercased()
    }

    /// Port of TS `compileGlobRegex` (src/infra/exec-allowlist-pattern.ts): the
    /// reference iterates UTF-16 code units, so a `*`/`?` immediately followed
    /// by a combining scalar is still a wildcard there; scalar iteration is
    /// unit-equivalent for the wildcards and escapes complete scalars.
    private static func regex(for pattern: String) -> NSRegularExpression? {
        var regex = "^"
        let scalars = Array(pattern.unicodeScalars)
        var idx = 0
        while idx < scalars.count {
            let scalar = scalars[idx]
            if scalar == "*" {
                if idx + 1 < scalars.count, scalars[idx + 1] == "*" {
                    regex += ".*"
                    idx += 2
                } else {
                    regex += "[^/]*"
                    idx += 1
                }
                continue
            }
            if scalar == "?" {
                regex += "."
                idx += 1
                continue
            }
            regex += NSRegularExpression.escapedPattern(for: String(scalar))
            idx += 1
        }
        regex += "$"
        return try? NSRegularExpression(pattern: regex, options: [.caseInsensitive])
    }
}
