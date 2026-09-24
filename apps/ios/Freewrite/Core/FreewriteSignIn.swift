import Foundation
import CryptoKit
import Security

struct FreewriteUser: Codable, Equatable, Sendable { let id: String; let name: String; let email: String }
struct FreewriteLogin: Codable, Equatable, Sendable { let token: String; let user: FreewriteUser; let expiresAt: String }
enum SignInError: Error, LocalizedError, Equatable, Sendable {
    case cancelled, invalidCallback, unavailable, expired, storage, accountChanged
    var errorDescription: String? {
        switch self {
        case .cancelled: "sign-in cancelled."
        case .invalidCallback: "couldn’t finish signing in. try again."
        case .unavailable: "couldn’t connect to freewrite. try again."
        case .expired: "your session expired. sign in again."
        case .storage: "couldn’t save your account securely. try again."
        case .accountChanged: "your account changed. sign in again before deleting it."
        }
    }
}

struct FreewriteSignInRequest: Sendable {
    static let callbackScheme = "dev.gtfol.freewrite"
    let verifier: String
    let state: String
    init() throws { verifier = try Self.randomValue(); state = try Self.randomValue() }
    init(verifier: String, state: String) { self.verifier = verifier; self.state = state }
    var challenge: String { Self.base64url(Data(SHA256.hash(data: Data(verifier.utf8)))) }
    var url: URL {
        var url = URLComponents(string: "https://freewrite.gtfol.dev/ios/connect")!
        url.queryItems = [URLQueryItem(name: "code_challenge", value: challenge), URLQueryItem(name: "state", value: state)]
        return url.url!
    }
    func code(from callback: URL) throws -> String {
        guard let url = URLComponents(url: callback, resolvingAgainstBaseURL: false),
              url.scheme == Self.callbackScheme, url.host == "auth", url.path == "/callback",
              url.user == nil, url.password == nil, url.port == nil, url.fragment == nil,
              let items = url.queryItems, items.count == 2,
              items.filter({ $0.name == "state" }).count == 1,
              items.filter({ $0.name == "code" }).count == 1,
              items.first(where: { $0.name == "state" })?.value == state,
              let code = items.first(where: { $0.name == "code" })?.value,
              code.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else { throw SignInError.invalidCallback }
        return code
    }
    private static func randomValue() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw SignInError.unavailable }
        return base64url(Data(bytes))
    }
    private static func base64url(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}

struct AccountHTTPResult: Sendable { let data: Data; let status: Int }
protocol AccountTransport: Sendable { func send(_ request: URLRequest) async throws -> AccountHTTPResult }
private final class AccountRedirectBlocker: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}
struct AccountURLSessionTransport: AccountTransport {
    private let session: URLSession
    init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil; configuration.urlCredentialStorage = nil; configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 30; configuration.timeoutIntervalForResource = 45
        session = URLSession(configuration: configuration, delegate: AccountRedirectBlocker(), delegateQueue: nil)
    }
    func send(_ request: URLRequest) async throws -> AccountHTTPResult {
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse, data.count <= 64_000 else { throw SignInError.unavailable }
        return AccountHTTPResult(data: data, status: response.statusCode)
    }
}

struct FreewriteAccountClient: Sendable {
    let transport: any AccountTransport
    func exchange(_ attempt: FreewriteSignInRequest, callback: URL) async throws -> FreewriteLogin {
        let code = try attempt.code(from: callback)
        var request = request(path: "exchange", method: "POST")
        request.httpBody = try JSONEncoder().encode(["code": code, "code_verifier": attempt.verifier])
        let result = try await send(request)
        guard let login = try? JSONDecoder().decode(FreewriteLogin.self, from: result.data), Self.valid(login) else { throw SignInError.invalidCallback }
        return login
    }
    func user(token: String) async throws -> FreewriteUser {
        let result = try await send(request(path: "session", method: "GET", token: token))
        struct Response: Decodable { let user: FreewriteUser }
        guard let value = try? JSONDecoder().decode(Response.self, from: result.data), Self.valid(value.user) else { throw SignInError.unavailable }
        return value.user
    }
    func revoke(token: String) async throws {
        do { _ = try await send(request(path: "session", method: "DELETE", token: token)) }
        catch SignInError.expired { return }
    }
    func deleteAccount(_ login: FreewriteLogin) async throws {
        var request = request(path: "account", method: "DELETE", token: login.token)
        request.httpBody = try JSONEncoder().encode(["confirmation": "DELETE", "expectedUserId": login.user.id])
        let result = try await send(request)
        struct Response: Decodable { let deleted: Bool }
        guard (try? JSONDecoder().decode(Response.self, from: result.data).deleted) == true else { throw SignInError.unavailable }
    }
    static func valid(_ login: FreewriteLogin) -> Bool {
        let format = ISO8601DateFormatter()
        format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return login.token.range(of: "^freewrite_[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil && valid(login.user)
            && login.expiresAt.count <= 64 && format.date(from: login.expiresAt) != nil
    }
    private static func valid(_ user: FreewriteUser) -> Bool {
        !user.id.isEmpty && user.id.count <= 256 && user.name.count <= 1000 && !user.email.isEmpty && user.email.count <= 1000
    }
    private func request(path: String, method: String, token: String? = nil) -> URLRequest {
        var request = URLRequest(url: URL(string: "https://freewrite.gtfol.dev/api/ios/\(path)")!)
        request.httpMethod = method; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return request
    }
    private func send(_ request: URLRequest) async throws -> AccountHTTPResult {
        let result: AccountHTTPResult
        do { result = try await transport.send(request) } catch { throw SignInError.unavailable }
        switch result.status {
        case 200: return result
        case 401: throw SignInError.expired
        case 409: throw SignInError.accountChanged
        default: throw SignInError.unavailable
        }
    }
}
