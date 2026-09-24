#if os(iOS)
import XCTest
import AVFoundation
import Speech
@testable import Freewrite

@MainActor final class AudioBufferBridgeTests: XCTestCase {
    func testTapCreatedOnMainActorAcceptsAudioOnBackgroundQueue() async throws {
        let source = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 2))
        let target = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1))
        let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
        let bridge = try AudioBufferBridge(from: source, to: target, continuation: continuation) {
            continuation.finish()
        }
        // Construct the exact installed callback on MainActor, then invoke it
        // off-actor just as the physical microphone does. Actor inheritance
        // would terminate the test process before conversion can complete.
        let tap = bridge.tap
        try await Task.detached {
            let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 2))
            let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4096))
            buffer.frameLength = 4096
            for channel in 0..<Int(format.channelCount) {
                buffer.floatChannelData![channel].initialize(repeating: 0.25, count: 4096)
            }
            tap(buffer, AVAudioTime(sampleTime: 0, atRate: 48_000))
            continuation.finish()
        }.value
        var received = 0
        for await input in stream {
            XCTAssertEqual(input.buffer.format.sampleRate, 16_000)
            XCTAssertEqual(input.buffer.format.channelCount, 1)
            XCTAssertGreaterThan(input.buffer.frameLength, 0)
            received += 1
        }
        XCTAssertEqual(received, 1)
    }
}
#endif
