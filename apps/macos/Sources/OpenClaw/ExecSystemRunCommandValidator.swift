import Foundation

/// Swift mirror of WednesdayAI-core `src/infra/system-run-command.ts`
/// (`validateSystemRunCommandConsistency` + `resolveSystemRunCommand`).
///
/// Contract: rawCommand is display/approval text only — structured argv is
/// authoritative. A rawCommand mismatch is not a rejection; the display falls
/// back to the argv-derived text. Shell wrapper payloads are only used as the
/// display when the invocation has no env-manipulation prelude and no trailing
/// positional argv carriers after the inline command flag.
enum ExecSystemRunCommandValidator {
    struct ResolvedCommand {
        let displayCommand: String
    }

    enum ValidationResult {
        case ok(ResolvedCommand)
        case invalid(message: String)
    }

    private static let posixOrPowerShellInlineWrapperNames: Set<String> = [
        "ash", "bash", "dash", "fish", "ksh", "powershell", "pwsh", "sh", "zsh",
    ]

    static func resolve(command: [String], rawCommand: String?) -> ValidationResult {
        let normalizedRaw = self.normalizeRaw(rawCommand)
        guard !command.isEmpty else {
            if normalizedRaw != nil {
                return .invalid(message: "rawCommand requires params.command")
            }
            return .ok(ResolvedCommand(displayCommand: ""))
        }

        let shellWrapperResolution = ExecDispatchWrapper.extractShellWrapperCommand(command, rawCommand: nil)
        let shellCommand = shellWrapperResolution.isWrapper ? shellWrapperResolution.command : nil

        let shellWrapperPositionalArgv = self.hasTrailingPositionalArgvAfterInlineCommand(command)
        let envManipulationBeforeShellWrapper =
            shellWrapperResolution.isWrapper && ExecDispatchWrapper.hasEnvManipulationBeforeShellWrapper(command)
        let mustBindDisplayToFullArgv = envManipulationBeforeShellWrapper || shellWrapperPositionalArgv

        let inferred: String = if let shellCommand, !mustBindDisplayToFullArgv {
            shellCommand.trimmingCharacters(in: .whitespacesAndNewlines)
        } else {
            ExecCommandFormatter.displayString(for: command)
        }

        if let raw = normalizedRaw, raw != inferred {
            // rawCommand is display text only; structured argv is authoritative.
            // Mismatch is a warning in core, not a rejection — surface the
            // argv-derived display instead.
            return .ok(ResolvedCommand(displayCommand: inferred))
        }

        return .ok(ResolvedCommand(displayCommand: normalizedRaw ?? inferred))
    }

    private static func normalizeRaw(_ rawCommand: String?) -> String? {
        let trimmed = rawCommand?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func hasTrailingPositionalArgvAfterInlineCommand(_ argv: [String]) -> Bool {
        let wrapperArgv = self.unwrapShellWrapperArgv(argv)
        guard let token0 = wrapperArgv.first?.trimmingCharacters(in: .whitespacesAndNewlines), !token0.isEmpty else {
            return false
        }
        let wrapper = ExecDispatchWrapper.normalizeExecutableToken(token0)
        guard self.posixOrPowerShellInlineWrapperNames.contains(wrapper) else {
            return false
        }

        let inlineCommandIndex: Int? = if wrapper == "powershell" || wrapper == "pwsh" {
            ExecDispatchWrapper.resolveInlineCommandMatch(
                wrapperArgv,
                flags: ExecDispatchWrapper.powershellInlineCommandFlags).valueTokenIndex
        } else {
            ExecDispatchWrapper.resolveInlineCommandMatch(
                wrapperArgv,
                flags: ExecDispatchWrapper.posixInlineCommandFlags,
                allowCombinedC: true).valueTokenIndex
        }
        guard let inlineCommandIndex else {
            return false
        }
        let start = inlineCommandIndex + 1
        guard start < wrapperArgv.count else {
            return false
        }
        return wrapperArgv[start...].contains { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }

    private static func unwrapShellWrapperArgv(_ argv: [String]) -> [String] {
        let dispatchUnwrapped = ExecDispatchWrapper.unwrapDispatchWrappersForResolution(argv)
        let multiplexer = ExecDispatchWrapper.unwrapKnownShellMultiplexerInvocation(dispatchUnwrapped)
        if case let .unwrapped(_, unwrapped) = multiplexer {
            return unwrapped
        }
        return dispatchUnwrapped
    }
}
