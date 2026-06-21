// BelieveBoyMac — main entry point.
//
// BEL-147 stage 1: hosts two WindowGroups — the main app shell and a
// dedicated "Sign in" window that opens when the user is signed out. The
// `App` body opens / dismisses the auth window in response to changes in
// `AppSession.phaseChangeToken` (so we don't have to plumb `openWindow` /
// `dismissWindow` through the AppSession model itself).

import SwiftUI

@main
struct BelieveBoyMacApp: App {
    @State private var session = AppSession()
    @Environment(\.openWindow) private var openWindow
    @Environment(\.dismissWindow) private var dismissWindow

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(session)
                .frame(minWidth: 1100, minHeight: 720)
        }
        .windowResizability(.contentSize)
        .windowToolbarStyle(.unified(showsTitle: true))
        .commands {
            SidebarCommands()
            ToolbarCommands()
            // Hook up global ⌘K command palette here in a later milestone.
        }

        // Login window shown when no session is in Keychain.
        Window("Sign in", id: "auth") {
            LoginView()
                .environment(session)
                .frame(minWidth: 420, minHeight: 520)
        }
        .windowResizability(.contentSize)
        .defaultPosition(.center)
    }
}