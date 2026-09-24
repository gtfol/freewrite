import Foundation
import Observation

@MainActor @Observable final class SessionTimer {
    private(set) var remaining: TimeInterval = 15 * 60
    private(set) var running = false
    private var endsAt: Date?

    func toggle(now: Date = .now) {
        if running { remaining = max(0, endsAt?.timeIntervalSince(now) ?? 0); endsAt = nil }
        else { endsAt = now.addingTimeInterval(remaining > 0 ? remaining : 15 * 60) }
        running.toggle()
    }
    func reset() { remaining = 15 * 60; running = false; endsAt = nil }
    func tick(now: Date = .now) {
        guard running, let endsAt else { return }
        remaining = max(0, endsAt.timeIntervalSince(now))
        if remaining == 0 { reset() }
    }
    var label: String {
        let seconds = Int(ceil(remaining))
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }
}
