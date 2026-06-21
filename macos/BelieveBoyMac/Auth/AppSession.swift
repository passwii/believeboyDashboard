// Application session — single source of truth for auth state.
//
// BEL-147 stage 1: replaces the stage-0 placeholder bootstrap (which
// trusted the cached token without verifying) with a real `bootstrap()`
// that calls `/api/v1/auth/me` to validate the Keychain-stored session.
//
// Phase state machine:
//
//      bootstrapping ─── token valid ──▶ signedIn(user:)
//            │
//            └── token missing / 401 / network error ──▶ signedOut
//
// On 401 from any API call, callers should call `signOut()` (which clears
// Keychain + flips to `.signedOut`); the App layer watches `phase` and
// re-opens the auth window via `OpenWindowAction`.

import Foundation
import Observation
import SwiftUI

@Observable
@MainActor
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

    /// Triggered when the App-level view sees the phase flip — drives the
    /// open/close of the dedicated "Sign in" window. The actual
    /// OpenWindowAction lives in `BelieveBoyMacApp.swift` because
    /// SwiftUI's environment value for it can only be used inside a View.
    var phaseChangeToken: Int = 0

    // ─── Auth window plumbing ───────────────────────────────────────────────
    // macOS supports multiple WindowGroups; we open the auth one on demand
    // instead of presenting as a sheet, so the user can move it across
    // displays. The actual OpenWindowAction call happens in the App scene.

    func noteAuthWindowShouldOpen() {
        phaseChangeToken &+= 1
    }

    // ─── Lifecycle ─────────────────────────────────────────────────────────
    func bootstrap() async {
        guard let ctx = await KeychainStore.shared.loadSession() else {
            self.phase = .signedOut
            self.phaseChangeToken &+= 1
            return
        }
        do {
            let me = try await APIClient.shared.me()
            let user = me.toSessionUser()
            self.phase = .signedIn(user: user)
            // Refresh cached fields in case role / display name changed since
            // last login (the backend is the source of truth).
            var refreshed = ctx
            refreshed.userId = user.id
            refreshed.email = user.email
            refreshed.userName = user.name
            refreshed.operatorName = user.operatorNameZh
            refreshed.roleType = user.role.rawValue
            refreshed.isAdmin = user.isAdmin
            await KeychainStore.shared.saveSession(refreshed)
        } catch APIError.unauthorized {
            // Session expired or revoked server-side — wipe and bounce back to login.
            await KeychainStore.shared.clear()
            self.phase = .signedOut
            self.phaseChangeToken &+= 1
        } catch {
            // Network error: keep the cached session so the user isn't logged
            // out by a transient offline state. The next API call will
            // surface the real problem.
            let fallback = SessionUser(
                id: ctx.userId,
                name: ctx.userName ?? ctx.email,
                email: ctx.email,
                operatorNameZh: ctx.operatorName,
                isAdmin: ctx.isAdmin,
                role: SessionUser.Role(rawValue: ctx.roleType) ?? .operator
            )
            self.phase = .signedIn(user: fallback)
        }
    }

    func signIn(context: SessionContext) async {
        await KeychainStore.shared.saveSession(context)
        let user = SessionUser(
            id: context.userId,
            name: context.userName ?? context.email,
            email: context.email,
            operatorNameZh: context.operatorName,
            isAdmin: context.isAdmin,
            role: SessionUser.Role(rawValue: context.roleType) ?? .operator
        )
        self.phase = .signedIn(user: user)
        self.phaseChangeToken &+= 1
    }

    func signOut() async {
        await KeychainStore.shared.clear()
        self.phase = .signedOut
        self.phaseChangeToken &+= 1
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
    var operatorNameZh: String?
    var isAdmin: Bool
    var role: Role

    enum Role: String, Codable {
        case admin
        case businessdev
        case `operator`
        case factory
    }

    static let placeholder = SessionUser(
        id: "preview",
        name: "Preview User",
        email: "preview@local",
        operatorNameZh: nil,
        isAdmin: true,
        role: .admin
    )
}