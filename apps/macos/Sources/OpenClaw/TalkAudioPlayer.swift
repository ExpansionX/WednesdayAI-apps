import AVFoundation
import Foundation
import os
import OSLog

@MainActor
final class TalkAudioPlayer: NSObject, @preconcurrency AVAudioPlayerDelegate {
    static let shared = TalkAudioPlayer()

    private let logger = os.Logger(subsystem: "ai.openclaw", category: "talk.tts")
    private var player: AVAudioPlayer?
    private var playback: Playback?

    private final class Playback: @unchecked Sendable {
        private let lock = NSLock()
        private var finished = false
        private var continuation: CheckedContinuation<TalkPlaybackResult, Never>?
        private var watchdog: Task<Void, Never>?

        func setContinuation(_ continuation: CheckedContinuation<TalkPlaybackResult, Never>) {
            self.lock.lock()
            defer { self.lock.unlock() }
            self.continuation = continuation
        }

        func setWatchdog(_ task: Task<Void, Never>?) {
            self.lock.lock()
            let old = self.watchdog
            self.watchdog = task
            self.lock.unlock()
            old?.cancel()
        }

        func cancelWatchdog() {
            self.setWatchdog(nil)
        }

        func finish(_ result: TalkPlaybackResult) {
            let continuation: CheckedContinuation<TalkPlaybackResult, Never>?
            self.lock.lock()
            if self.finished {
                continuation = nil
            } else {
                self.finished = true
                continuation = self.continuation
                self.continuation = nil
            }
            self.lock.unlock()
            continuation?.resume(returning: result)
        }
    }

    func play(data: Data) async -> TalkPlaybackResult {
        self.stopInternal()

        let playback = Playback()
        self.playback = playback

        return await withCheckedContinuation { continuation in
            playback.setContinuation(continuation)
            // Arm the watchdog before touching CoreAudio: AVAudioPlayer
            // init/prepareToPlay/play can stall for seconds on headless or wedged audio
            // devices, and running them on the main actor would freeze the watchdog and
            // the whole app.
            self.armWatchdog(playback: playback)

            Task.detached(priority: .userInitiated) { [weak self] in
                var player: AVAudioPlayer?
                var failure: String?
                do {
                    let constructed = try AVAudioPlayer(data: data)
                    constructed.delegate = self
                    constructed.prepareToPlay()
                    if constructed.play() {
                        player = constructed
                    } else {
                        failure = "talk audio player refused to play"
                    }
                } catch {
                    failure = "talk audio player failed: \(error.localizedDescription)"
                }
                await MainActor.run {
                    self?.registerEngineResult(playback: playback, player: player, failure: failure)
                }
            }
        }
    }

    /// Registers an engine that was started off-main; discarded when the watchdog
    /// already finished the playback while the engine was still starting.
    @MainActor
    private func registerEngineResult(playback: Playback, player: AVAudioPlayer?, failure: String?) {
        guard self.playback === playback else {
            player?.stop()
            return
        }
        if let failure {
            self.logger.error("\(failure, privacy: .public)")
        }
        self.player = player
        if player == nil {
            self.finish(playback: playback, result: TalkPlaybackResult(finished: false, interruptedAt: nil))
        }
    }

    func stop() -> Double? {
        guard let player else { return nil }
        let time = player.currentTime
        self.stopInternal(interruptedAt: time)
        return time
    }

    func audioPlayerDidFinishPlaying(_: AVAudioPlayer, successfully flag: Bool) {
        self.stopInternal(finished: flag)
    }

    private func stopInternal(finished: Bool = false, interruptedAt: Double? = nil) {
        guard let playback else { return }
        let result = TalkPlaybackResult(finished: finished, interruptedAt: interruptedAt)
        self.finish(playback: playback, result: result)
    }

    private func finish(playback: Playback, result: TalkPlaybackResult) {
        playback.cancelWatchdog()
        playback.finish(result)

        guard self.playback === playback else { return }
        self.playback = nil
        self.player?.stop()
        self.player = nil
    }

    private func stopInternal() {
        if let playback = self.playback {
            let interruptedAt = self.player?.currentTime
            self.finish(
                playback: playback,
                result: TalkPlaybackResult(finished: false, interruptedAt: interruptedAt))
            return
        }
        self.player?.stop()
        self.player = nil
    }

    private func armWatchdog(playback: Playback) {
        playback.setWatchdog(Task { @MainActor [weak self] in
            guard let self else { return }

            do {
                try await Task.sleep(nanoseconds: 650_000_000)
            } catch {
                return
            }
            if Task.isCancelled { return }

            guard self.playback === playback else { return }
            if self.player?.isPlaying != true {
                self.logger.error("talk audio player did not start playing")
                self.finish(playback: playback, result: TalkPlaybackResult(finished: false, interruptedAt: nil))
                return
            }

            let duration = self.player?.duration ?? 0
            let timeoutSeconds = min(max(2.0, duration + 2.0), 5 * 60.0)
            do {
                try await Task.sleep(nanoseconds: UInt64(timeoutSeconds * 1_000_000_000))
            } catch {
                return
            }
            if Task.isCancelled { return }

            guard self.playback === playback else { return }
            guard self.player?.isPlaying == true else { return }
            self.logger.error("talk audio player watchdog fired")
            self.finish(playback: playback, result: TalkPlaybackResult(finished: false, interruptedAt: nil))
        })
    }
}

struct TalkPlaybackResult: Sendable {
    let finished: Bool
    let interruptedAt: Double?
}
