// Login view — wires the SwiftUI form to the FastAPI backend.
//
// BEL-147 stage 1: on submit, calls `APIClient.login(email:password:)`. The
// backend (`backend/app/api/v1/endpoints/auth.py`) takes `email` + `password`
// and returns a `LoginResponse` with the session_id + role info we persist
// into Keychain. Errors come back as typed `APIError`; the form renders the
// `errorDescription` below the inputs in red. The button is disabled while
// the request is in flight to prevent double-submit.

import SwiftUI

struct LoginView: View {
    @Environment(AppSession.self) private var session
    @Environment(\.openWindow) private var openWindow
    @Environment(\.dismissWindow) private var dismissWindow

    @State private var email: String = ""
    @State private var password: String = ""
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "lock.shield")
                .font(.system(size: 36, weight: .light))
                .foregroundStyle(.tint)

            Text("BelieveBoy Mac")
                .font(.title2.weight(.semibold))

            VStack(alignment: .leading, spacing: 12) {
                TextField("Email", text: $email)
                    .textFieldStyle(.roundedBorder)
                    .textContentType(.username)
                    .autocorrectionDisabled()
                SecureField("Password", text: $password)
                    .textFieldStyle(.roundedBorder)
                    .textContentType(.password)
            }
            .frame(maxWidth: 320)

            if let message = errorMessage {
                Text(message)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 320)
            }

            Button {
                Task { await submit() }
            } label: {
                if isSubmitting {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Signing in…")
                    }
                } else {
                    Text("Sign in")
                }
            }
            .keyboardShortcut(.defaultAction)
            .disabled(isSubmitting || email.isEmpty || password.isEmpty)
            .controlSize(.large)

            Spacer(minLength: 0)

            VStack(spacing: 2) {
                Text("Backend: \(APIClient.defaultBaseURL.absoluteString)")
                Text("API key: \(APIClient.defaultAPIKey.prefix(8))…")
            }
            .font(.caption2)
            .foregroundStyle(.tertiary)
        }
        .padding(32)
        .frame(minWidth: 420, minHeight: 520)
    }

    private func submit() async {
        guard !isSubmitting else { return }
        isSubmitting = true
        errorMessage = nil
        defer { isSubmitting = false }
        do {
            let response = try await APIClient.shared.login(email: email, password: password)
            guard response.isActive else {
                errorMessage = "This account is disabled. Contact an administrator."
                return
            }
            await session.signIn(context: response.toSessionContext())
            dismissWindow(id: "auth")
        } catch let error as APIError {
            errorMessage = error.errorDescription
        } catch {
            errorMessage = "Unexpected error — \(error.localizedDescription)"
        }
    }
}

#Preview {
    LoginView()
        .environment(AppSession.preview)
}