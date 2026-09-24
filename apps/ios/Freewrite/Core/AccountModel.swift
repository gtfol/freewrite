import Foundation
import Observation

@MainActor protocol BrowserAuthenticating {
    func authenticate(url: URL, callbackScheme: String) async throws -> URL
}

@MainActor @Observable final class AccountModel {
    private(set) var login: FreewriteLogin?
    private(set) var busy = false
    var error: String?
    private let credentials: any AccountCredentialStoring
    private let client: FreewriteAccountClient
    private let browser: any BrowserAuthenticating
    init(credentials: any AccountCredentialStoring, client: FreewriteAccountClient, browser: any BrowserAuthenticating) {
        self.credentials = credentials; self.client = client; self.browser = browser
        do { login = try credentials.read() } catch { self.error = SignInError.storage.localizedDescription }
    }
    func signIn() async {
        guard !busy, login == nil else { return }
        busy = true; error = nil; defer { busy = false }
        do {
            let attempt = try FreewriteSignInRequest()
            let callback = try await browser.authenticate(url: attempt.url, callbackScheme: FreewriteSignInRequest.callbackScheme)
            let received = try await client.exchange(attempt, callback: callback)
            do { try credentials.save(received) }
            catch { try? await client.revoke(token: received.token); throw SignInError.storage }
            login = received
        } catch SignInError.cancelled { /* Closing the browser leaves the existing writing alone. */ }
        catch { self.error = (error as? SignInError ?? .unavailable).localizedDescription }
    }
    func refresh() async {
        guard !busy, let existing = login else { return }
        busy = true; defer { busy = false }
        do {
            let user = try await client.user(token: existing.token)
            guard user.id == existing.user.id else { throw SignInError.expired }
            let updated = FreewriteLogin(token: existing.token, user: user, expiresAt: existing.expiresAt)
            try credentials.save(updated); login = updated
        } catch SignInError.expired {
            do { try credentials.save(nil); login = nil; error = SignInError.expired.localizedDescription }
            catch { self.error = SignInError.storage.localizedDescription }
        } catch { self.error = (error as? SignInError ?? .unavailable).localizedDescription }
    }
    func signOut() async {
        guard !busy, let existing = login else { return }
        busy = true; error = nil; defer { busy = false }
        do { try await client.revoke(token: existing.token); try credentials.save(nil); login = nil }
        catch { self.error = (error as? SignInError ?? .storage).localizedDescription }
    }
    func deleteAccount(expectedUserID: String) async {
        guard !busy, let existing = login, existing.user.id == expectedUserID else { error = SignInError.accountChanged.localizedDescription; return }
        busy = true; error = nil; defer { busy = false }
        do { try await client.deleteAccount(existing); try credentials.save(nil); login = nil }
        catch { self.error = (error as? SignInError ?? .storage).localizedDescription }
    }
}
