import Foundation

enum UsageEvent: String, CaseIterable, Sendable {
    case appOpened = "app_opened"
    case entryCreated = "entry_created"
    case historyOpened = "history_opened"
    case settingsOpened = "settings_opened"
    case timerStarted = "timer_started"
    case dictationRequested = "dictation_requested"
    case dictationStarted = "dictation_started"
    case dictationFinished = "dictation_finished"
    case dictationFailed = "dictation_failed"
    case signInCompleted = "sign_in_completed"
    case signOutCompleted = "sign_out_completed"
}

// Rebuild properties from a small allowlist. Future SDK defaults cannot upload content.
enum UsageAnalyticsPolicy {
    static func properties(event: String, properties: [String: Any]) -> [String: Any]? {
        guard UsageEvent(rawValue: event) != nil else { return nil }
        var safe: [String: Any] = ["platform": "ios", "$process_person_profile": false, "$geoip_disable": true, "$ip": NSNull()]
        for key in ["$device_id", "$session_id"] {
            if let value = properties[key] as? String, UUID(uuidString: value) != nil { safe[key] = value }
        }
        for key in ["$app_version", "$app_build", "$lib_version"] {
            if let value = properties[key] as? String, value.range(of: #"^\d+(\.\d+)*$"#, options: .regularExpression) != nil { safe[key] = value }
        }
        safe["$lib"] = "posthog-ios"
        return safe
    }
}
