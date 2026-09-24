import XCTest
#if canImport(FreewriteCore)
@testable import FreewriteCore
#else
@testable import Freewrite
#endif

private actor AccountStub: AccountTransport {
    var responses: [AccountHTTPResult]
    private(set) var requests: [URLRequest] = []
    init(_ responses: [AccountHTTPResult] = []) { self.responses = responses }
    func send(_ request: URLRequest) async throws -> AccountHTTPResult {
        requests.append(request)
        guard !responses.isEmpty else { throw URLError(.notConnectedToInternet) }
        return responses.removeFirst()
    }
}
@MainActor private final class AccountMemory: AccountCredentialStoring {
    var login: FreewriteLogin?
    var failSave = false
    func read() throws -> FreewriteLogin? { login }
    func save(_ login: FreewriteLogin?) throws { if failSave { throw SignInError.storage }; self.login = login }
}
@MainActor private final class AccountBrowser: BrowserAuthenticating {
    var cancelled = false
    func authenticate(url: URL, callbackScheme: String) async throws -> URL {
        if cancelled { throw SignInError.cancelled }
        let state = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!.first { $0.name == "state" }!.value!
        return URL(string: "\(callbackScheme)://auth/callback?code=\(String(repeating: "c", count: 43))&state=\(state)")!
    }
}

@MainActor final class AccountTests: XCTestCase {
    private let login = FreewriteLogin(token: "freewrite_" + String(repeating: "t", count: 43),
                                      user: FreewriteUser(id: "alice", name: "Alice", email: "alice@example.test"), expiresAt: "2027-01-01T00:00:00.000Z")
    private func result(_ status: Int = 200) throws -> AccountHTTPResult { AccountHTTPResult(data: try JSONEncoder().encode(login), status: status) }
    private func model(_ memory: AccountMemory, _ transport: AccountStub, _ browser: AccountBrowser = AccountBrowser()) -> AccountModel {
        AccountModel(credentials: memory, client: FreewriteAccountClient(transport: transport), browser: browser)
    }
    func testPKCEMatchesRFCAndNeverPutsVerifierInBrowserURL() throws {
        let attempt = FreewriteSignInRequest(verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", state: String(repeating: "s", count: 43))
        XCTAssertEqual(attempt.challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
        XCTAssertEqual(attempt.url.host, "freewrite.gtfol.dev")
        XCTAssertEqual(attempt.url.scheme, "https")
        XCTAssertFalse(attempt.url.absoluteString.contains(attempt.verifier))
        let first = try FreewriteSignInRequest(); let second = try FreewriteSignInRequest()
        XCTAssertEqual(first.verifier.count, 43); XCTAssertNotEqual(first.verifier, second.verifier); XCTAssertNotEqual(first.state, second.state)
    }
    func testCallbackRejectsWrongStateHostDuplicateFieldsAndFragments() throws {
        let state = String(repeating: "s", count: 43); let code = String(repeating: "c", count: 43)
        let attempt = FreewriteSignInRequest(verifier: "unused", state: state)
        let valid = "dev.gtfol.freewrite://auth/callback?code=\(code)&state=\(state)"
        XCTAssertEqual(try attempt.code(from: URL(string: valid)!), code)
        for value in [valid + "&state=\(state)", valid + "&code=\(code)", valid + "#fragment", valid.replacingOccurrences(of: "auth/", with: "evil/"), valid.replacingOccurrences(of: "state=\(state)", with: "state=wrong"), valid.replacingOccurrences(of: "://auth", with: "://user@auth"), valid.replacingOccurrences(of: "://auth", with: "://auth:443"), valid.replacingOccurrences(of: "dev.gtfol.freewrite:", with: "https:")] {
            XCTAssertThrowsError(try attempt.code(from: URL(string: value)!))
        }
    }
    func testSignInExchangesCodeOverHTTPSAndPersistsBeforeShowingAccount() async throws {
        let memory = AccountMemory(); let transport = AccountStub([try result()]); let account = model(memory, transport)
        await account.signIn()
        XCTAssertEqual(account.login, login); XCTAssertEqual(memory.login, login); XCTAssertNil(account.error)
        let requests = await transport.requests; let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.url?.absoluteString, "https://freewrite.gtfol.dev/api/ios/exchange"); XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
        let fields = try JSONDecoder().decode([String: String].self, from: XCTUnwrap(request.httpBody))
        XCTAssertEqual(Set(fields.keys), ["code", "code_verifier"]); XCTAssertEqual(fields["code_verifier"]?.count, 43)
    }
    func testCancelledSignInDoesNotCreateSessionOrDisplayError() async {
        let memory = AccountMemory(); let transport = AccountStub(); let browser = AccountBrowser(); browser.cancelled = true
        let account = model(memory, transport, browser); await account.signIn()
        XCTAssertNil(account.login); XCTAssertNil(account.error); XCTAssertFalse(account.busy)
        let requests = await transport.requests; XCTAssertTrue(requests.isEmpty)
    }
    func testFailedKeychainWriteRevokesNewSessionAndStaysSignedOut() async throws {
        let memory = AccountMemory(); memory.failSave = true
        let transport = AccountStub([try result(), AccountHTTPResult(data: Data(), status: 200)])
        let account = model(memory, transport); await account.signIn()
        XCTAssertNil(account.login); XCTAssertEqual(account.error, SignInError.storage.localizedDescription)
        let requests = await transport.requests; XCTAssertEqual(requests.count, 2); XCTAssertEqual(requests.last?.httpMethod, "DELETE")
        XCTAssertEqual(requests.last?.value(forHTTPHeaderField: "Authorization"), "Bearer \(login.token)")
    }
    func testOfflineSignOutKeepsCredentialForRevocationRetry() async {
        let memory = AccountMemory(); memory.login = login
        let account = model(memory, AccountStub()); await account.signOut()
        XCTAssertEqual(account.login, login); XCTAssertEqual(memory.login, login); XCTAssertNotNil(account.error)
    }
    func testExpiredSessionClearsCredentialButNetworkFailureDoesNot() async {
        let memory = AccountMemory(); memory.login = login
        let offline = model(memory, AccountStub()); await offline.refresh(); XCTAssertEqual(memory.login, login)
        let expired = model(memory, AccountStub([AccountHTTPResult(data: Data(), status: 401)])); await expired.refresh()
        XCTAssertNil(memory.login); XCTAssertNil(expired.login); XCTAssertEqual(expired.error, SignInError.expired.localizedDescription)
    }
    func testSignOutRevokesBeforeClearingAndHandlesAlreadyRevokedSession() async {
        for status in [200, 401] {
            let memory = AccountMemory(); memory.login = login; let transport = AccountStub([AccountHTTPResult(data: Data(), status: status)])
            let account = model(memory, transport); await account.signOut()
            XCTAssertNil(account.login); XCTAssertNil(memory.login)
            let requests = await transport.requests; XCTAssertEqual(requests.first?.httpMethod, "DELETE")
        }
    }
    func testDeleteAccountRequiresTheAccountShownInConfirmation() async throws {
        let memory = AccountMemory(); memory.login = login
        let transport = AccountStub([AccountHTTPResult(data: Data(#"{"deleted":true}"#.utf8), status: 200)])
        let account = model(memory, transport); await account.deleteAccount(expectedUserID: "bob")
        let before = await transport.requests; XCTAssertTrue(before.isEmpty); XCTAssertEqual(memory.login, login)
        await account.deleteAccount(expectedUserID: "alice")
        let after = await transport.requests; let request = try XCTUnwrap(after.first)
        XCTAssertEqual(try JSONDecoder().decode([String: String].self, from: XCTUnwrap(request.httpBody)), ["confirmation": "DELETE", "expectedUserId": "alice"])
        XCTAssertNil(account.login); XCTAssertNil(memory.login)
    }
    #if os(iOS)
    func testSecureCredentialRoundTripAndRemoval() throws {
        let store = AccountCredentialStore(service: "dev.gtfol.freewrite.tests.\(UUID().uuidString)")
        defer { try? store.save(nil) }
        XCTAssertNil(try store.read()); try store.save(login); XCTAssertEqual(try store.read(), login)
        try store.save(nil); XCTAssertNil(try store.read())
    }
    #endif
}
