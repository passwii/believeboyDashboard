// Login view — placeholder for stage 1.
//
// BEL-147 stage 1 will wire this to POST /api/v1/auth/login. Stage 0
// only ships the layout.

import SwiftUI

struct LoginView: View {
    @Environment(AppSession.self) private var session

    @State private var username: String = ""
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
                TextField("Username", text: $username)
                    .textFieldStyle(.roundedBorder)
                    .textContentType(.username)
                SecureField("Password", text: $password)
                    .textFieldStyle(.roundedBorder)
                    .textContentType(.password)
            }
            .frame(maxWidth: 320)

            if let message = errorMessage {
                Text(message)
                    .font(.callout)
                    .foregroundStyle(.red)
            }

            Button {
                Task { await submit() }
            } label: {
                if isSubmitting {
                    ProgressView().controlSize(.small)
                } else {
                    Text("Sign in")
                }
            }
            .keyboardShortcut(.defaultAction)
            .disabled(isSubmitting || username.isEmpty || password.isEmpty)
            .controlSize(.large)

            Spacer(minLength: 0)

            Text("Backend: \(APIClient.defaultBaseURL.absoluteString)")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .padding(32)
        .frame(minWidth: 420, minHeight: 520)
    }

    private func submit() async {
        // Stage 1 implementation lands here. For now we just bounce.
        isSubmitting = true
        defer { isSubmitting = false }
        errorMessage = "Stage 0 placeholder — login wiring lands in stage 1."
    }
}

#Preview {
    LoginView()
        .environment(AppSession.preview)
}