import AppKit
import Foundation

enum SessionActions {
    static func patchSession(
        key: String,
        thinking: String?? = nil,
        verbose: String?? = nil) async throws
    {
        var params: [String: AnyHashable] = ["key": AnyHashable(key)]

        if let thinking {
            params["thinkingLevel"] = thinking.map(AnyHashable.init) ?? AnyHashable(NSNull())
        }
        if let verbose {
            params["verboseLevel"] = verbose.map(AnyHashable.init) ?? AnyHashable(NSNull())
        }

        _ = try await ControlChannel.shared.request(method: "sessions.patch", params: params)
    }

    static func resetSession(key: String) async throws {
        _ = try await ControlChannel.shared.request(
            method: "sessions.reset",
            params: ["key": AnyHashable(key)])
    }

    static func deleteSession(key: String) async throws {
        _ = try await ControlChannel.shared.request(
            method: "sessions.delete",
            params: ["key": AnyHashable(key)])
    }

    static func compactSession(key: String, maxLines: Int = 400) async throws {
        // D9: sessions.compact runs model compaction synchronously (safety timeout 300 s in
        // src/agents/pi-embedded-runner/compaction-safety-timeout.ts, plus lane/pre-flight
        // headroom), so it needs a deadline far above the 15 s default. The call must also
        // never be replayed by the connection's auto-recovery: a replay would run model
        // compaction a second time.
        _ = try await ControlChannel.shared.request(
            method: "sessions.compact",
            params: ["key": AnyHashable(key), "maxLines": AnyHashable(maxLines)],
            timeoutMs: 330_000,
            noReplay: true)
    }

    @MainActor
    static func confirmDestructiveAction(title: String, message: String, action: String) -> Bool {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: action)
        alert.addButton(withTitle: "Cancel")
        alert.alertStyle = .warning
        return alert.runModal() == .alertFirstButtonReturn
    }

    @MainActor
    static func presentError(title: String, error: Error) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        alert.addButton(withTitle: "OK")
        alert.alertStyle = .warning
        alert.runModal()
    }

    @MainActor
    static func openSessionLogInCode(sessionKey: String, sessionId: String) {
        Task { @MainActor in
            do {
                let url = try await exportSessionLogToJSONL(
                    sessionKey: sessionKey,
                    fallbackSessionId: sessionId)
                self.openInEditor(url: url)
            } catch {
                self.presentError(title: "Open session log failed", error: error)
            }
        }
    }

    /// Pages `sessions.export` until `nextCursor` is absent and writes the whole transcript
    /// as a JSONL file (0600). The gateway holds the SQL session store; there is no local
    /// session file to open anymore (#437). Cursors are opaque tokens bound to the session
    /// they were issued for; a response whose `sessionId` differs from the first page's ends
    /// the export with an error instead of mixing two transcripts.
    @MainActor
    private static func exportSessionLogToJSONL(
        sessionKey: String,
        fallbackSessionId: String) async throws -> URL
    {
        var lines: [String] = []
        var sessionId: String?
        var cursor: String?
        while true {
            var params: [String: AnyHashable] = ["key": AnyHashable(sessionKey)]
            if let cursor {
                params["cursor"] = AnyHashable(cursor)
            }
            // Each page reads the whole session server-side, so one page can take well over
            // the 15 s default; the deadline is per page, not cumulative.
            let data = try await ControlChannel.shared.request(
                method: "sessions.export",
                params: params,
                timeoutMs: 120_000)
            guard let page = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw ControlChannelError.badResponse("sessions.export returned no payload")
            }
            if let returnedId = page["sessionId"] as? String, !returnedId.isEmpty {
                if let previous = sessionId, previous != returnedId {
                    throw ControlChannelError.badResponse(
                        "sessions.export switched sessions mid-export (\(previous) → \(returnedId)); "
                            + "the session was rotated — restart the export")
                }
                sessionId = returnedId
            }
            lines.append(contentsOf: page["lines"] as? [String] ?? [])
            guard let next = page["nextCursor"] as? String else { break }
            if next == cursor {
                throw ControlChannelError.badResponse("sessions.export returned a repeated cursor")
            }
            cursor = next
        }

        let name = sessionId ?? fallbackSessionId
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("openclaw-session-\(name).jsonl")
        let payload = Data(lines.map { $0 + "\n" }.joined().utf8)
        if !FileManager.default.createFile(
            atPath: url.path,
            contents: payload,
            attributes: [.posixPermissions: 0o600])
        {
            throw ControlChannelError.badResponse("could not write \(url.path)")
        }
        return url
    }

    @MainActor
    private static func openInEditor(url: URL) {
        let proc = Process()
        proc.launchPath = "/usr/bin/env"
        proc.arguments = ["code", url.path]
        if (try? proc.run()) != nil {
            return
        }

        NSWorkspace.shared.activateFileViewerSelecting([url])
    }
}
