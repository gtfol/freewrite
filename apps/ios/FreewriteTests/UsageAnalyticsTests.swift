import Foundation
import Testing
#if canImport(FreewriteCore)
@testable import FreewriteCore
#else
@testable import Freewrite
#endif

struct UsageAnalyticsTests {
    @Test func contentAndSDKDefaultsAreRemoved() throws {
        let id = UUID().uuidString
        let input: [String: Any] = ["content": "PRIVATE", "email": "PRIVATE", "$screen_name": "PRIVATE",
                                   "$set": ["email": "PRIVATE"], "$current_url": "PRIVATE", "$exception_message": "PRIVATE",
                                   "$device_id": id, "$app_version": "1.0", "$app_build": "6"]
        for event in UsageEvent.allCases {
            let safe = try #require(UsageAnalyticsPolicy.properties(event: event.rawValue, properties: input))
            let encoded = try JSONSerialization.data(withJSONObject: safe)
            #expect(!String(decoding: encoded, as: UTF8.self).contains("PRIVATE"))
            #expect(safe["$device_id"] as? String == id)
            #expect(safe["$app_build"] as? String == "6")
            #expect(safe["$geoip_disable"] as? Bool == true)
        }
    }
    @Test func unexpectedEventsAndIdentifiersAreRejected() {
        for name in ["$identify", "$snapshot", "$screen", "$exception", "private text"] {
            #expect(UsageAnalyticsPolicy.properties(event: name, properties: [:]) == nil)
        }
        let safe = UsageAnalyticsPolicy.properties(event: "app_opened", properties: ["$device_id": "email@example.com", "$app_version": "private text"])
        #expect(safe?["$device_id"] == nil)
        #expect(safe?["$app_version"] == nil)
    }
}
