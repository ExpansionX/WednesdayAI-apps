import AppKit
import os

/// Central manager for Dock icon visibility.
/// Shows the Dock icon while any windows are visible, regardless of user preference.
final class DockIconManager: NSObject, @unchecked Sendable {
    static let shared = DockIconManager()

    private var windowsObservation: NSKeyValueObservation?
    private var launchObserver: NSObjectProtocol?
    private let logger = Logging.Logger(subsystem: "ai.openclaw", category: "DockIconManager")

    override private init() {
        super.init()
        self.setupObservers()
        Task { @MainActor in
            self.updateDockVisibility()
        }
    }

    deinit {
        self.windowsObservation?.invalidate()
        if let launchObserver {
            NotificationCenter.default.removeObserver(launchObserver)
        }
        NotificationCenter.default.removeObserver(self)
    }

    func updateDockVisibility(defaults: UserDefaults = .standard) {
        // Read the preference before hopping actors: UserDefaults is not
        // Sendable, so it cannot cross into the @MainActor task.
        let userWantsDockHidden = !defaults.bool(forKey: showDockIconKey)
        Task { @MainActor in
            guard NSApp != nil else {
                self.logger.log(level: .warning, "NSApp not ready, skipping Dock visibility update")
                return
            }

            let visibleWindows = NSApp?.windows.filter { window in
                window.isVisible &&
                    window.frame.width > 1 &&
                    window.frame.height > 1 &&
                    !window.isKind(of: NSPanel.self) &&
                    "\(type(of: window))" != "NSPopupMenuWindow" &&
                    window.contentViewController != nil
            } ?? []

            let hasVisibleWindows = !visibleWindows.isEmpty
            if !userWantsDockHidden || hasVisibleWindows {
                NSApp?.setActivationPolicy(.regular)
            } else {
                NSApp?.setActivationPolicy(.accessory)
            }
        }
    }

    func temporarilyShowDock() {
        Task { @MainActor in
            guard NSApp != nil else {
                self.logger.log(level: .warning, "NSApp not ready, cannot show Dock icon")
                return
            }
            NSApp.setActivationPolicy(.regular)
        }
    }

    private func setupObservers() {
        Task { @MainActor in
            guard let app = NSApp else {
                // Headless or early startup: AppKit attaches its observers once the
                // app finishes launching instead of polling in a perpetual task.
                self.logger.log(level: .warning, "NSApp not ready; waiting for app launch to attach Dock observers")
                self.awaitLaunchThenRegisterObservers()
                return
            }
            self.registerObservers(on: app)
        }
    }

    @MainActor
    private func awaitLaunchThenRegisterObservers() {
        self.launchObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didFinishLaunchingNotification,
            object: nil,
            queue: .main)
        { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, let app = NSApp else { return }
                self.registerObservers(on: app)
                self.updateDockVisibility()
            }
        }
    }

    @MainActor
    private func registerObservers(on app: NSApplication) {
        self.windowsObservation = app.observe(\.windows, options: [.new]) { [weak self] _, _ in
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(50))
                self?.updateDockVisibility()
            }
        }

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(self.windowVisibilityChanged),
            name: NSWindow.didBecomeKeyNotification,
            object: nil)
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(self.windowVisibilityChanged),
            name: NSWindow.didResignKeyNotification,
            object: nil)
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(self.windowVisibilityChanged),
            name: NSWindow.willCloseNotification,
            object: nil)
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(self.dockPreferenceChanged),
            name: UserDefaults.didChangeNotification,
            object: nil)
    }

    @objc
    private func windowVisibilityChanged(_: Notification) {
        Task { @MainActor in
            self.updateDockVisibility()
        }
    }

    @objc
    private func dockPreferenceChanged(_ notification: Notification) {
        guard let userDefaults = notification.object as? UserDefaults,
              userDefaults == UserDefaults.standard
        else { return }

        Task { @MainActor in
            self.updateDockVisibility()
        }
    }
}
