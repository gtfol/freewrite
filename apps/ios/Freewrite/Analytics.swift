import Foundation
import PostHog

@MainActor enum Analytics {
    static let preferenceKey = "usageAnalyticsEnabled"
    private static var configured = false
    static func setup() {
        // No simulator, unit-test, or Debug traffic in production analytics.
        #if !DEBUG && !targetEnvironment(simulator)
        guard !configured, ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil else { return }
        // Public write-only project token; never a personal API key.
        let config = PostHogConfig(projectToken: "phc_BFXoGnfotrysQqXJDJRjguMeTMmxuMrABBWgVzMSF7Ww", host: "https://us.i.posthog.com")
        config.captureApplicationLifecycleEvents = false
        config.captureScreenViews = false
        config.enableSwizzling = false
        config.captureElementInteractions = false
        config.captureSwiftUIElementInteractions = false
        config.captureAutocaptureElementText = false
        config.capturePushNotificationSubscriptions = false
        config.capturePushNotificationOpened = false
        config.sessionReplay = false
        config.surveys = false
        config.errorTrackingConfig.autoCapture = false
        config.preloadFeatureFlags = false
        config.sendFeatureFlagEvent = false
        config.setDefaultPersonProperties = false
        config.personProfiles = .never
        config.optOut = UserDefaults.standard.object(forKey: preferenceKey) as? Bool == false
        config.setBeforeSend { @Sendable event in
            guard let properties = UsageAnalyticsPolicy.properties(event: event.event, properties: event.properties) else { return nil }
            event.properties = properties
            return event
        }
        PostHogSDK.shared.setup(config)
        configured = true
        track(.appOpened)
        #endif
    }
    static func track(_ event: UsageEvent) {
        guard configured else { return }
        PostHogSDK.shared.capture(event.rawValue)
    }
    static func setEnabled(_ enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: preferenceKey)
        guard configured else { return }
        if enabled { PostHogSDK.shared.optIn() } else { PostHogSDK.shared.optOut() }
    }
}
