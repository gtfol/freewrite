import AuthenticationServices
import UIKit

@MainActor final class BrowserSignIn: NSObject, BrowserAuthenticating, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?
    private var pending: CheckedContinuation<URL, Error>?
    private var anchor: ASPresentationAnchor?
    func authenticate(url: URL, callbackScheme: String) async throws -> URL {
        guard session == nil else { throw SignInError.unavailable }
        guard let window = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
            .filter({ $0.activationState == .foregroundActive }).flatMap(\.windows).first(where: \.isKeyWindow) else { throw SignInError.unavailable }
        anchor = window
        return try await withCheckedThrowingContinuation { continuation in
            pending = continuation
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: callbackScheme) { @Sendable [weak self] callback, error in
                Task { @MainActor in
                    if let callback { self?.finish(.success(callback)) }
                    else if (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin { self?.finish(.failure(SignInError.cancelled)) }
                    else { self?.finish(.failure(SignInError.unavailable)) }
                }
            }
            self.session = session; session.presentationContextProvider = self
            if !session.start() { finish(.failure(SignInError.unavailable)) }
        }
    }
    private func finish(_ result: Result<URL, Error>) {
        guard let continuation = pending else { return }
        pending = nil; session = nil; continuation.resume(with: result)
    }
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        // authenticate() requires and retains the presenting window before start().
        anchor!
    }
}
