import XCTest
#if SWIFT_PACKAGE
@testable import FreewriteCore
#else
@testable import Freewrite
#endif

private final class StubReply: @unchecked Sendable {
    private let lock = NSLock()
    private var response = (200, Data())
    func set(_ status: Int, _ data: Data) { lock.lock(); defer { lock.unlock() }; response = (status, data) }
    func read() -> (Int, Data) { lock.lock(); defer { lock.unlock() }; return response }
}
private final class CleanerURLProtocol: URLProtocol, @unchecked Sendable {
    static let reply = StubReply()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let (status, data) = Self.reply.read()
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@MainActor final class CleanerNetworkTests: XCTestCase {
    private func cleaner(text: String, status: String = "completed", http: Int = 200) throws -> OpenAITextCleaner {
        let data = try JSONSerialization.data(withJSONObject: ["status": status, "output": [["type": "message", "content": [["type": "output_text", "text": text]]]]])
        CleanerURLProtocol.reply.set(http, data)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CleanerURLProtocol.self]
        return OpenAITextCleaner(credential: .init(key: "synthetic-test-key", consent: true), session: URLSession(configuration: configuration))
    }
    func testAcceptsOnlyWordPreservingCleanup() async throws {
        let service = try cleaner(text: "I am ready.")
        let result = try await service.clean("um i am ready")
        XCTAssertEqual(result, "I am ready.")
    }
    func testRewritingFailsClosed() async throws {
        let service = try cleaner(text: "I am ready.")
        do { _ = try await service.clean("I am not ready"); XCTFail("Changed meaning was accepted") }
        catch { XCTAssertEqual(error as? WritingError, .cleanup) }
    }
    func testIncompleteResponseRejected() async throws {
        let service = try cleaner(text: "Hello.", status: "incomplete")
        do { _ = try await service.clean("hello"); XCTFail("Partial response was accepted") }
        catch { XCTAssertEqual(error as? WritingError, .cleanup) }
    }
    func testServerFailureRejected() async throws {
        let service = try cleaner(text: "", http: 503)
        do { _ = try await service.clean("words"); XCTFail("Failed response was accepted") }
        catch { XCTAssertEqual(error as? WritingError, .cleanup) }
    }
}
