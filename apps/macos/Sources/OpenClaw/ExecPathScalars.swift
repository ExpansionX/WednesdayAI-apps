import Foundation

/// UTF-8/scalar-level string classification for exec path and argv handling.
///
/// TypeScript/Node classifies and slices path and argv strings by UTF-16 code
/// units, while Swift String operations work on extended grapheme clusters. An
/// ASCII delimiter immediately followed by a combining scalar (e.g. "/" +
/// U+0301) fuses into one Character, so `hasPrefix`, `hasSuffix`, `contains`,
/// `split(separator:)` and Character index arithmetic miss it and diverge from
/// the TS reference (review findings S2/T1). Every delimiter used in POSIX
/// path and argv classification is single-byte ASCII, and UTF-8 is a
/// self-synchronizing code (a continuation byte can never equal an ASCII
/// byte), so byte-level checks here reproduce the TS code-unit semantics
/// exactly.
enum ExecPathScalars {
    static let slash: UInt8 = 0x2F // "/"
    static let backslash: UInt8 = 0x5C // "\\"
    static let equals: UInt8 = 0x3D // "="

    /// Node `path.isAbsolute` (POSIX): the first byte is "/" — independent of
    /// grapheme clustering with a following combining scalar.
    static func isAbsolute(_ path: String) -> Bool {
        path.utf8.first == self.slash
    }

    /// JS `String#startsWith` (byte-prefix equivalent for the ASCII needles
    /// used by the exec path code).
    static func hasPrefix(_ value: String, _ prefix: String) -> Bool {
        value.utf8.starts(with: prefix.utf8)
    }

    /// JS `String#endsWith` (byte-suffix equivalent for ASCII needles).
    static func hasSuffix(_ value: String, _ suffix: String) -> Bool {
        let suffixBytes = suffix.utf8
        guard value.utf8.count >= suffixBytes.count else { return false }
        return value.utf8.suffix(suffixBytes.count).elementsEqual(suffixBytes)
    }

    /// JS `String#includes` for a single ASCII unit.
    static func containsUnit(_ value: String, _ unit: UInt8) -> Bool {
        value.utf8.contains(unit)
    }

    /// JS `value.replace(/\\/g, "/")`: map every backslash unit to "/".
    static func backslashesToSlashes(_ value: String) -> String {
        guard value.utf8.contains(self.backslash) else { return value }
        let bytes = value.utf8.map { $0 == Self.backslash ? Self.slash : $0 }
        // The bytes come from a valid String, so decoding cannot fail.
        return String(bytes: bytes, encoding: .utf8) ?? value
    }

    /// JS `lower.split("=", 2)[0]`: the part before the first "=" unit.
    static func prefixBeforeUnit(_ value: String, _ unit: UInt8) -> String {
        guard let index = value.utf8.firstIndex(of: unit) else { return value }
        return String(bytes: value.utf8[..<index], encoding: .utf8) ?? value
    }

    /// Drops the last `count` bytes (used for ASCII suffixes such as ".exe").
    static func droppingSuffixBytes(_ value: String, _ count: Int) -> String {
        String(bytes: value.utf8.dropLast(count), encoding: .utf8) ?? value
    }

    /// Drops the first `count` bytes (used after a matched ASCII prefix such as
    /// "~/"). Character-based dropFirst would remove a combining scalar fused
    /// with the matched ASCII delimiter (review U1).
    static func droppingPrefixBytes(_ value: String, _ count: Int) -> String {
        String(bytes: value.utf8.dropFirst(count), encoding: .utf8) ?? value
    }
}
