import Foundation

/// Thin adapter over `ExecDispatchWrapper` mirroring core
/// `extractShellWrapperCommand` (src/infra/exec-wrapper-resolution.ts): dispatch
/// wrappers (env/nice/nohup/stdbuf/timeout, transparent usage only) and shell
/// multiplexers (busybox/toybox) are resolved before shell wrapper detection.
/// Blocked dispatch wrappers (sudo/doas/chrt/…) are never treated as shell wrappers.
enum ExecShellWrapperParser {
    struct ParsedShellWrapper {
        let isWrapper: Bool
        let command: String?

        static let notWrapper = ParsedShellWrapper(isWrapper: false, command: nil)
    }

    static func extract(command: [String], rawCommand: String?) -> ParsedShellWrapper {
        let extracted = ExecDispatchWrapper.extractShellWrapperCommand(command, rawCommand: rawCommand)
        return ParsedShellWrapper(isWrapper: extracted.isWrapper, command: extracted.command)
    }
}
