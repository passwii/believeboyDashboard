// Application session — single source of truth for auth state.
//
// BEL-147 stage 0: replaces NextAuth.js + the proxy.ts 60s session cache.
// Mirrors the contract documented in
// `frontend/proxy.ts` (BACKEND_FAILURE_THRESHOLD, circuit-breaker, and
// `/api/v1/auth/me` semantics) so that kick/disable latency is consistent
// across web and macOS clients.

import Foundation
import Observation
import SwiftUI

@Observable
final class AppSession {
    enum Phase: Equatable {
        case bootstrapping
        case signedOut
        case signedIn(user: SessionUser)
    }

    private(set) var phase: Phase = .bootstrapping

    var isAuthenticated: Bool {
        if case .signedIn = phase { return true }
        return false
    }

    var currentUser: SessionUser? {
        if case .signedIn(let user) = phase { return user }
        return nil
    }

    // ─── Auth window plumbing ───────────────────────────────────────────────
    // macOS supports multiple WindowGroups; we open the auth one on demand
    // instead of presenting as a sheet, so the user can move it across
    // displays.
    func openAuthWindow() {
        // OpenWindow is a SwiftUI environment value; we route through
        // `OpenWindowAction` from the .commands modifier on the App scene
        // in a future stage. For stage 0 we mark intent only.
    }

    // ─── Lifecycle ─────────────────────────────────────────────────────────
    func bootstrap() async {
        if let token = await KeychainStore.shared.loadAccessToken() {
            // TODO(BEL-147 stage 1): call /api/v1/auth/me and confirm.
            // Stage 0 just trusts the cached token and signs in.
            self.phase = .signedIn(user: .placeholder)
            _ = token
        } else {
            self.phase = .signedOut
        }
    }

    func signIn(token: String, refreshToken: String?, user: SessionUser) async {
        await KeychainStore.shared.saveAccessToken(token, refreshToken: refreshToken)
        self.phase = .signedIn(user: user)
    }

    func signOut() async {
        await KeychainStore.shared.clear()
        self.phase = .signedOut
    }

    // ─── Preview support ───────────────────────────────────────────────────
    static let preview: AppSession = {
        let s = AppSession()
        s.phase = .signedIn(user: .placeholder)
        return s
    }()
}

struct SessionUser: Equatable, Codable {
    var id: String
    var name: String
    var email: String
    var role: Role

    enum Role: String, Codable {
        case admin
        case businessdev
        case operator
        case factory
    }

    static let placeholder = SessionUser(
        id: "preview",
        name: "Preview User",
        email: "preview@local",
        role: .admin
    )
}
